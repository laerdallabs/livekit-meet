import * as React from 'react';
import Link from 'next/link';
import { RecordingList } from './RecordingList';
import styles from '../../styles/Recordings.module.css';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Recordings | LiveKit Meet',
};

export default function RecordingsPage() {
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
