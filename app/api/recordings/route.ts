import { ListObjectsV2Command, S3Client, type _Object } from '@aws-sdk/client-s3';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type Recording = {
  key: string;
  roomName: string;
  identity?: string;
  recordedAt: string;
  size: number;
  contentType: 'video/mp4' | 'application/vnd.apple.mpegurl';
  url: string;
};

export type RecordingsResponse = {
  recordings: Recording[];
};

// Legacy flat MP4 layout (before SegmentedFileOutput was the default):
//   ${ISO}-${roomName}.mp4   at the bucket root
const LEGACY_MP4_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)-(.+)\.mp4$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

// Safety cap. We scan the whole bucket in one pass; stop here so a runaway
// bucket can't OOM the response. We can't really sort by the most "recent" recordings right now with just S3
// TODO: once buckets routinely exceed this, switch to server-side pagination
const MAX_RECORDINGS = 2000;

const CACHE_TTL_MS = 60_000;
let cache: { at: number; body: RecordingsResponse } | null = null;

function publicUrl(bucket: string, region: string, endpoint: string | undefined, key: string) {
  // TODO: when buckets are private, we may have to use signed cookies
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  if (endpoint) {
    const base = endpoint.replace(/\/+$/, '');
    return `${base}/${bucket}/${encodedKey}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function parseLegacyMp4(
  obj: _Object,
  bucket: string,
  region: string,
  endpoint: string | undefined,
): Recording | null {
  const key = obj.Key;
  if (!key || !key.endsWith('.mp4')) return null;
  // Legacy MP4s only live at the bucket root.
  if (key.includes('/')) return null;
  const match = LEGACY_MP4_PATTERN.exec(key);
  return {
    key,
    roomName: match ? match[2] : key,
    recordedAt: match ? match[1] : (obj.LastModified ?? new Date(0)).toISOString(),
    size: obj.Size ?? 0,
    contentType: 'video/mp4',
    url: publicUrl(bucket, region, endpoint, key),
  };
}

/**
 * Best-effort extraction of room/identity/timestamp from an arbitrary HLS
 * recording prefix. Works for any depth (our 3-level layout, Astra's 5-level
 * layout, etc.) by inspecting path segments:
 *   - recordedAt: last segment if it's an ISO timestamp, else the playlist's
 *     LastModified.
 *   - roomName: first segment (top-level grouping).
 *   - identity: second-to-last segment if recordedAt came from the path,
 *     otherwise the last segment.
 */
function metaFromPrefix(prefix: string, playlistLastModified: Date | undefined) {
  const segments = prefix.replace(/\/$/, '').split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? prefix;
  const lastIsTimestamp = ISO_TIMESTAMP_PATTERN.test(last);

  const recordedAt = lastIsTimestamp ? last : (playlistLastModified ?? new Date(0)).toISOString();

  const roomName = segments[0] ?? prefix;
  const identity = lastIsTimestamp ? segments[segments.length - 2] : segments[segments.length - 1];

  return { roomName, identity, recordedAt };
}

/**
 * Flat scan of the bucket: ask S3 for every key, keep the .m3u8 files. This
 * is dramatically cheaper than a recursive folder walk — one ListObjectsV2
 * call returns up to 1000 keys, so a bucket with ~14k objects (e.g. 2k
 * recordings × ~7 segments each) needs ~14 calls regardless of nesting depth.
 *
 * The playlist filename isn't fixed: SegmentedFileOutput defaults to
 * "playlist.m3u8" but callers can set anything (Astra uses a UUID per device,
 * etc.). We treat *any* .m3u8 as a candidate, then dedupe by parent folder
 * (preferring one literally named "playlist.m3u8" in case a recording has
 * both a master and variant playlists).
 */
async function findPlaylists(client: S3Client, bucket: string) {
  const byPrefix = new Map<
    string,
    { key: string; size: number; lastModified: Date | undefined; prefix: string }
  >();

  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const o of resp.Contents ?? []) {
      if (!o.Key || !o.Key.endsWith('.m3u8')) continue;
      const slash = o.Key.lastIndexOf('/');
      const prefix = slash >= 0 ? o.Key.slice(0, slash + 1) : '';
      const existing = byPrefix.get(prefix);
      // Prefer a literal "playlist.m3u8" over UUID-named siblings (master vs
      // variant playlists in multi-rendition HLS).
      const isCanonical = o.Key === `${prefix}playlist.m3u8`;
      if (!existing || isCanonical) {
        byPrefix.set(prefix, {
          key: o.Key,
          size: o.Size ?? 0,
          lastModified: o.LastModified,
          prefix,
        });
      }
      if (byPrefix.size >= MAX_RECORDINGS) break;
    }
    if (byPrefix.size >= MAX_RECORDINGS) break;
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  return Array.from(byPrefix.values());
}

export async function GET(req: Request) {
  const {
    NEXT_PUBLIC_SHOW_RECORDINGS,
    S3_BUCKET,
    S3_REGION,
    S3_ENDPOINT,
    S3_KEY_ID,
    S3_KEY_SECRET,
  } = process.env;

  if (NEXT_PUBLIC_SHOW_RECORDINGS !== 'true') {
    return new NextResponse('Recordings feature not configured', { status: 404 });
  }

  if (!S3_BUCKET || !S3_REGION) {
    return new NextResponse('Recordings feature not configured', { status: 404 });
  }

  const bypassCache = new URL(req.url).searchParams.get('refresh') === '1';
  if (!bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const client = new S3Client({
    region: S3_REGION,
    ...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(S3_KEY_ID && S3_KEY_SECRET
      ? { credentials: { accessKeyId: S3_KEY_ID, secretAccessKey: S3_KEY_SECRET } }
      : {}),
  });

  try {
    const recordings: Recording[] = [];

    // Pick up legacy root-level .mp4 files. Delimiter:'/' makes this a single
    // small call against root only.
    const rootList = await client.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Delimiter: '/' }),
    );
    for (const obj of rootList.Contents ?? []) {
      const rec = parseLegacyMp4(obj, S3_BUCKET, S3_REGION, S3_ENDPOINT);
      if (rec) recordings.push(rec);
    }

    const found = await findPlaylists(client, S3_BUCKET);
    for (const f of found) {
      const { roomName, identity, recordedAt } = metaFromPrefix(f.prefix, f.lastModified);
      recordings.push({
        key: f.key,
        roomName,
        identity,
        recordedAt,
        size: f.size,
        contentType: 'application/vnd.apple.mpegurl',
        url: publicUrl(S3_BUCKET, S3_REGION, S3_ENDPOINT, f.key),
      });
    }

    recordings.sort((a, b) => {
      if (a.recordedAt > b.recordedAt) return -1;
      if (a.recordedAt < b.recordedAt) return 1;
      // Stable tie-breaker: same timestamp shouldn't shuffle between requests.
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    const body: RecordingsResponse = { recordings };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list recordings';
    return new NextResponse(message, { status: 500 });
  }
}
