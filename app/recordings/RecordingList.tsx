'use client';

import Hls from 'hls.js';
import * as React from 'react';
import styles from '../../styles/Recordings.module.css';
import type { RecordingsResponse } from '../api/recordings/route';

type Recording = RecordingsResponse['recordings'][number];

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-configured' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; recordings: Recording[] };

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatType(contentType: Recording['contentType']) {
  return contentType === 'application/vnd.apple.mpegurl' ? 'HLS' : 'MP4';
}

function VideoPlayer({
  src,
  contentType,
  recordingKey,
}: {
  src: string;
  contentType: Recording['contentType'];
  recordingKey: string;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isHls = contentType === 'application/vnd.apple.mpegurl';
    if (!isHls) {
      video.src = src;
      return;
    }

    // Safari / iOS plays HLS natively without hls.js.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }

    // Browser supports neither native HLS nor MSE — best-effort attempt.
    video.src = src;
  }, [src, contentType, recordingKey]);

  return <video key={recordingKey} ref={videoRef} className={styles.video} controls playsInline />;
}

export function RecordingList() {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const pageSize = 20;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/recordings', { cache: 'no-store' });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: 'not-configured' });
          return;
        }
        if (!res.ok) {
          const text = await res.text();
          setState({ kind: 'error', message: text || `Request failed: ${res.status}` });
          return;
        }
        const body: RecordingsResponse = await res.json();
        setState({ kind: 'ready', recordings: body.recordings });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load recordings';
        setState({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p className={styles.message}>Loading recordings…</p>;
  }
  if (state.kind === 'not-configured') {
    return (
      <p className={styles.message}>Recording playback is not configured for this deployment.</p>
    );
  }
  if (state.kind === 'error') {
    return <p className={styles.message}>Error loading recordings: {state.message}</p>;
  }
  if (state.recordings.length === 0) {
    return <p className={styles.message}>No recordings yet.</p>;
  }

  const total = state.recordings.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp page if the recordings list shrinks (e.g. refresh in a future iteration).
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const pageRecordings = state.recordings.slice(startIdx, endIdx);

  const selected = state.recordings.find((r) => r.key === selectedKey) ?? null;

  return (
    <div className={styles.layout}>
      <div className={styles.listColumn}>
        <ul className={styles.list}>
          {pageRecordings.map((r) => {
            const isActive = r.key === selectedKey;
            return (
              <li key={r.key}>
                <button
                  type="button"
                  className={`${styles.row} ${isActive ? styles.rowActive : ''}`}
                  onClick={() => setSelectedKey(isActive ? null : r.key)}
                  aria-pressed={isActive}
                >
                  <span className={styles.roomName}>{r.roomName}</span>
                  {r.identity && <span className={styles.meta}>Participant: {r.identity}</span>}
                  <span className={styles.meta}>{formatTimestamp(r.recordedAt)}</span>
                  <span className={styles.meta}>
                    {formatType(r.contentType)}
                    {r.contentType === 'video/mp4' ? ` · ${formatSize(r.size)}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {totalPages > 1 && (
          <nav className={styles.pagination} aria-label="Recordings pagination">
            <button
              type="button"
              className="lk-button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage === 1}
            >
              Previous
            </button>
            <span className={styles.pageInfo}>
              {startIdx + 1}–{endIdx} of {total} · Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              className="lk-button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage === totalPages}
            >
              Next
            </button>
          </nav>
        )}
      </div>
      {selected && (
        <div className={styles.player}>
          <div className={styles.playerHeader}>
            <div>
              <div className={styles.roomName}>{selected.roomName}</div>
              {selected.identity && (
                <div className={styles.meta}>Participant: {selected.identity}</div>
              )}
              <div className={styles.meta}>{formatTimestamp(selected.recordedAt)}</div>
            </div>
            <a className="lk-button" href={selected.url} download>
              Download
            </a>
          </div>
          <VideoPlayer
            src={selected.url}
            contentType={selected.contentType}
            recordingKey={selected.key}
          />
        </div>
      )}
    </div>
  );
}
