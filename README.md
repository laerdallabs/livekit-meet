<a href="https://livekit.io/">
  <img src="./.github/assets/livekit-mark.png" alt="LiveKit logo" width="100" height="100">
</a>

# LiveKit Meet

<p>
  <a href="https://meet.livekit.io"><strong>Try the demo</strong></a>
  •
  <a href="https://github.com/livekit/components-js">LiveKit Components</a>
  •
  <a href="https://docs.livekit.io/">LiveKit Docs</a>
  •
  <a href="https://livekit.io/cloud">LiveKit Cloud</a>
  •
  <a href="https://blog.livekit.io/">Blog</a>
</p>

<br>

LiveKit Meet is an open source video conferencing app built on [LiveKit Components](https://github.com/livekit/components-js), [LiveKit Cloud](https://cloud.livekit.io/), and Next.js. It's been completely redesigned from the ground up using our new components library.

![LiveKit Meet screenshot](./.github/assets/livekit-meet.jpg)

## Fork additions

This fork adds an in-browser recordings library on top of the upstream LiveKit Meet:

- **HLS room recording** — the in-meeting "Record" button takes a snapshot of everyone currently in the room and starts a `startParticipantEgress` (with `SegmentedFileOutput`) for each participant. Each participant's `.m3u8` playlist + `.ts` segments are written to S3 under `${roomName}/${identity}/${timestamp}/`. Late joiners are not recorded; participants who leave have their egress auto-ended. Clicking Stop ends all active egresses for the room.
- **`/recordings` page** — lists every HLS recording (and any legacy MP4s) found in the configured S3 bucket, with built-in playback via [hls.js](https://github.com/video-dev/hls.js) (Safari uses native HLS). Gated behind `NEXT_PUBLIC_SHOW_RECORDINGS=true`.
- **Bucket-shape agnostic listing** — the `/api/recordings` endpoint does a flat S3 scan and infers `roomName` / `identity` / `recordedAt` from path segments, so it works with our own 3-level layout (`room/identity/timestamp/`) and deeper externally-produced layouts (e.g. 5-level UUID paths) without changes.
- **60s in-memory response cache** on `/api/recordings` to avoid re-scanning large buckets on every page load (`?refresh=1` bypasses it).
- **Path-segment validation** on the record endpoints to prevent caller-controlled `identity` / `roomName` values from escaping the intended S3 prefix.

See `.env.example` for the required `S3_*` variables and the `NEXT_PUBLIC_SHOW_RECORDINGS` toggle.

## Tech Stack

- This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).
- App is built with [@livekit/components-react](https://github.com/livekit/components-js/) library.

## Demo

Give it a try at https://meet.livekit.io.

## Dev Setup

Steps to get a local dev setup up and running:

1. Run `pnpm install` to install all dependencies.
2. Copy `.env.example` in the project root and rename it to `.env.local`.
3. Update the missing environment variables in the newly created `.env.local` file.
4. Run `pnpm dev` to start the development server and visit [http://localhost:3000](http://localhost:3000) to see the result.
5. Start development 🎉
