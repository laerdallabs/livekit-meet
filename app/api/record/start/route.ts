import { EgressClient, RoomServiceClient, S3Upload, SegmentedFileOutput } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';

function sanitizeSegment(s: string) {
  const cleaned = s.replace(/[\\/\x00]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

export async function GET(req: NextRequest) {
  try {
    const roomName = req.nextUrl.searchParams.get('roomName');

    /**
     * CAUTION:
     * for simplicity this implementation does not authenticate users and therefore allows anyone with knowledge of a roomName
     * to start/stop recordings for that room.
     * DO NOT USE THIS FOR PRODUCTION PURPOSES AS IS
     */

    if (roomName === null || roomName.length === 0) {
      return new NextResponse('Missing roomName parameter', { status: 403 });
    }

    const {
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      LIVEKIT_URL,
      S3_KEY_ID,
      S3_KEY_SECRET,
      S3_BUCKET,
      S3_ENDPOINT,
      S3_REGION,
    } = process.env;

    const hostURL = new URL(LIVEKIT_URL!);
    hostURL.protocol = 'https:';

    if (!S3_BUCKET || !S3_REGION || !S3_KEY_ID || !S3_KEY_SECRET) {
      return new NextResponse('S3 recording output is not configured on this server', { status: 500 });
    }

    const egressClient = new EgressClient(hostURL.origin, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const roomClient = new RoomServiceClient(hostURL.origin, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    // start a participant egress for every participant
    // currently in the room. Late joiners are not recorded.
    // recording is treated as a snapshot taken at start time.
    const [participants, existingEgresses] = await Promise.all([
      roomClient.listParticipants(roomName),
      egressClient.listEgress({ roomName }),
    ]);

    if (participants.length === 0) {
      return new NextResponse('No participants in room', { status: 409 });
    }

    // Skip identities already being recorded (idempotent for retries / new
    // joiners triggering a re-snapshot).
    const alreadyRecording = new Set(
      existingEgresses
        .filter((e) => e.status < 2 && e.request.case === 'participant' && e.request.value.identity)
        .map((e) => (e.request.value as { identity: string }).identity),
    );
    const toRecord = participants.filter((p) => !alreadyRecording.has(p.identity));

    if (toRecord.length === 0) {
      return new NextResponse('All participants already being recorded', { status: 409 });
    }

    // One timestamp for the whole batch so all participants in this snapshot
    // share a recording "session" prefix.
    const sessionTimestamp = new Date().toISOString();
    const safeRoom = sanitizeSegment(roomName);

    const results = await Promise.allSettled(
      toRecord.map(async (p) => {
        const recordingPrefix = `${safeRoom}/${sanitizeSegment(p.identity)}/${sessionTimestamp}`;
        // Segmented output = HLS with .ts segments vs. encoded file output = single .mp4
        const segmentsOutput = new SegmentedFileOutput({
          filenamePrefix: `${recordingPrefix}/segment`,
          playlistName: `${recordingPrefix}/playlist.m3u8`,
          segmentDuration: 5,
          output: {
            case: 's3',
            value: new S3Upload({
              endpoint: S3_ENDPOINT,
              accessKey: S3_KEY_ID,
              secret: S3_KEY_SECRET,
              region: S3_REGION,
              bucket: S3_BUCKET,
            }),
          },
        });
        const egressInfo = await egressClient.startParticipantEgress(roomName, p.identity, {
          segments: segmentsOutput,
        });
        return { identity: p.identity, egressId: egressInfo.egressId, prefix: recordingPrefix };
      }),
    );

    const started = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected');

    console.log('[record/start] room egress started', {
      roomName,
      requested: toRecord.length,
      started,
      failed: failed.length,
      failures: failed.map((r) => (r as PromiseRejectedResult).reason?.message),
    });

    if (started === 0) {
      return new NextResponse('Failed to start any recordings', { status: 500 });
    }

    return NextResponse.json({ started, failed: failed.length });
  } catch (error) {
    if (error instanceof Error) {
      console.error('[record/start] failed', error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}
