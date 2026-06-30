import * as React from 'react';
import Link from 'next/link';
import { RecordingList } from './RecordingList';
import { notFound } from 'next/navigation';
import styles from '../../styles/Recordings.module.css';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Recordings | LiveKit Meet',
};

export default function RecordingsPage() {
  if (process.env.NEXT_PUBLIC_SHOW_RECORDINGS !== 'true') {
    notFound();
  }

  return (
    <main className={styles.main} data-lk-theme="default">
      <div className={styles.header}>
        <h1 className={styles.heading}>Recordings</h1>
        <Link className="lk-button" href="/">
          Back
        </Link>
      </div>
      <RecordingList />
    </main>
  );
}
