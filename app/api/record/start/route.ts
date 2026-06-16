import { EgressClient, S3Upload, SegmentedFileOutput } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';

// Reject identities / room names that would break the S3 key layout or escape
// the prefix. Both are caller-controlled and interpolated straight into a path.
function isValidSegment(s: string) {
  return s.length > 0 && !/[\\/\x00]/.test(s) && !s.startsWith('.');
}

export async function GET(req: NextRequest) {
  try {
    const roomName = req.nextUrl.searchParams.get('roomName');
    const identity = req.nextUrl.searchParams.get('identity');

    /**
     * CAUTION:
     * for simplicity this implementation does not authenticate users and therefore allows anyone with knowledge of a roomName
     * to start/stop recordings for that room.
     * DO NOT USE THIS FOR PRODUCTION PURPOSES AS IS
     */

    if (roomName === null) {
      return new NextResponse('Missing roomName parameter', { status: 403 });
    }
    if (identity === null) {
      return new NextResponse('Missing identity parameter', { status: 403 });
    }
    if (!isValidSegment(roomName)) {
      return new NextResponse('Invalid roomName parameter', { status: 400 });
    }
    if (!isValidSegment(identity)) {
      return new NextResponse('Invalid identity parameter', { status: 400 });
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

    const egressClient = new EgressClient(hostURL.origin, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

    // Per-participant guard: it's fine for two participants in the same room to
    // each record themselves concurrently. Only block if *this* identity is already
    // being recorded.
    const existingEgresses = await egressClient.listEgress({ roomName });
    const myActive = existingEgresses.filter(
      (e) =>
        e.status < 2 && e.request.case === 'participant' && e.request.value.identity === identity,
    );
    if (myActive.length > 0) {
      return new NextResponse('Participant is already being recorded', { status: 409 });
    }

    const recordingPrefix = `${roomName}/${identity}/${new Date(Date.now()).toISOString()}`;

    // Segmented output = hls with .ts segments vs. encoded file output = single .mp4
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

    const egressInfo = await egressClient.startParticipantEgress(roomName, identity, {
      segments: segmentsOutput,
    });

    console.log('[record/start] participant egress started', {
      egressId: egressInfo.egressId,
      roomName,
      identity,
      status: egressInfo.status,
      prefix: recordingPrefix,
      error: egressInfo.error,
    });

    return new NextResponse(null, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error('[record/start] failed', error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}
