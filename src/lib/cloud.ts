import { useSyncExternalStore } from 'react';
import type { BrowserDb } from '@/db/browser';
import { getSetting } from '@/db/people';
import { migrate } from '@/db/schema';
import { cachedToken, forgetToken, signIn, wantScopes } from '@/sync/google';
import { DRIVE_SCOPE, DriveAuthError, download, findFile, upload } from '@/sync/drive';
import { isoDate } from './dates';

/**
 * Keeps this device's database in step with one copy in Google Drive, so every device shows the
 * same contacts. The whole database file is copied: changes here are uploaded a few seconds after
 * you make them, and changes from other devices are downloaded when you open or return to the app.
 *
 * If both sides changed since the last sync, you pick which copy to keep, and the other one is
 * downloaded as a backup file so nothing is lost.
 *
 * Sync settings live in localStorage, not in the database, because syncing replaces the database.
 */

export type CloudStatus = 'off' | 'idle' | 'syncing' | 'signin' | 'error';

export interface CloudState {
  enabled: boolean;
  clientId: string;
  status: CloudStatus;
  error: string | null;
  /** ISO time of the last successful sync on this device. */
  lastSync: string | null;
  /** Changes on this device that aren't in Drive yet. */
  pending: boolean;
  /** What the last sync did, for the settings page. */
  lastAction: string | null;
}

interface Saved {
  enabled?: boolean;
  clientId?: string;
  fileId?: string;
  /** Drive's version of the file when this device last matched it. */
  baseVersion?: string;
  dirty?: boolean;
  lastSync?: string;
}

const KEY = 'crm.cloud';
const PUSH_DELAY = 3000;
/** Check Drive for other devices' changes when coming back to the app, at most this often. */
const PULL_EVERY = 30_000;

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

function downloadFile(bytes: Uint8Array, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-sqlite3' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

class CloudSync {
  private db: BrowserDb | null = null;
  private onReplaced: () => void = () => {};
  private saved: Saved = load();
  private running: Promise<void> | null = null;
  private again = false;
  private pulling = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCheck = 0;
  private listeners = new Set<() => void>();
  private state: CloudState = this.snapshot('idle', null, null);
  constructor() {
    wantScopes('drive', this.saved.enabled ? [DRIVE_SCOPE] : null);
  }

  /** Called after every sync attempt finishes (the daily contacts check hooks in here). */
  onSynced: () => void = () => {};

  private snapshot(status: CloudStatus, error: string | null, lastAction: string | null): CloudState {
    const s = this.saved;
    return {
      enabled: !!s.enabled,
      clientId: s.clientId ?? '',
      status: s.enabled ? status : 'off',
      error,
      lastSync: s.lastSync ?? null,
      pending: !!s.dirty,
      lastAction,
    };
  }

  private set(status: CloudStatus, error: string | null = null, lastAction = this.state.lastAction) {
    this.state = this.snapshot(status, error, lastAction);
    this.listeners.forEach((l) => l());
  }

  private persist(patch: Partial<Saved>) {
    this.saved = { ...this.saved, ...patch };
    wantScopes('drive', this.saved.enabled ? [DRIVE_SCOPE] : null);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* storage blocked: sync still works for this visit */
    }
  }

  /** Resolves once any sync in progress is done, so other writers don't race a download. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;

  /** Hook up to the open database. Called once at startup, after migrations. */
  async start(db: BrowserDb, onReplaced: () => void) {
    this.db = db;
    this.onReplaced = onReplaced;
    db.onWrite = () => {
      if (this.pulling) return;
      if (!this.saved.dirty) this.persist({ dirty: true });
      if (!this.saved.enabled) return;
      this.set(this.state.status);
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => void this.sync(false), PUSH_DELAY);
    };
    if (!this.saved.clientId) {
      const fromDb = await getSetting(db, 'google_client_id');
      if (fromDb) this.persist({ clientId: fromDb });
    }
    document.addEventListener('visibilitychange', () => {
      if (!this.saved.enabled) return;
      if (document.visibilityState === 'visible' && Date.now() - this.lastCheck > PULL_EVERY) void this.sync(false);
      if (document.visibilityState === 'hidden' && this.saved.dirty) void this.sync(false);
    });
    addEventListener('online', () => this.saved.enabled && void this.sync(false));
    this.set('idle');
    if (this.saved.enabled) void this.sync(false);
  }

  setClientId(id: string) {
    this.persist({ clientId: id.trim() || undefined });
    this.set(this.state.status, this.state.error);
  }

  /** Turn sync on. Call from a tap: it opens Google's sign-in. */
  async enable() {
    this.persist({ enabled: true });
    await this.sync(true);
  }

  disable() {
    this.persist({ enabled: false });
    this.set('off', null, null);
  }

  /** A restore from a backup file should replace what's in Drive too. */
  markChanged() {
    if (this.db?.editing) return; // pressing Save uploads it
    this.db?.onWrite();
  }

  /** Sync now. `interactive` (from a tap) may open Google's sign-in when the hour-long sign-in has run out. */
  sync(interactive: boolean): Promise<void> {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run(interactive).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync(false);
      } else this.onSynced();
    });
    return this.running;
  }

  private async token(interactive: boolean): Promise<string | null> {
    const cached = cachedToken([DRIVE_SCOPE]);
    if (cached) return cached;
    if (!interactive || !this.saved.clientId) return null;
    return signIn(this.saved.clientId, [DRIVE_SCOPE]);
  }

  private async run(interactive: boolean) {
    const db = this.db;
    if (!db || !this.saved.enabled) return;
    // A download would replace what you're editing. Pressing Save syncs.
    if (db.editing) return;
    if (!this.saved.clientId) return this.set('error', 'Add your Google Client ID first.');
    if (!navigator.onLine) return this.set('error', 'You’re offline. Changes will sync when you’re back online.');
    this.set('syncing');
    try {
      const token = await this.token(interactive);
      if (!token) return this.set('signin');
      this.lastCheck = Date.now();
      const action = await this.exchange(db, token);
      this.persist({ lastSync: new Date().toISOString() });
      this.set('idle', null, action);
    } catch (e) {
      if (e instanceof DriveAuthError) {
        forgetToken();
        return this.set('signin', interactive ? e.message : null);
      }
      console.error('Google Drive sync failed', e);
      this.set('error', e instanceof Error ? e.message : String(e));
    }
  }

  private async exchange(db: BrowserDb, token: string): Promise<string> {
    const s = this.saved;
    const localPeople = (await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM people'))?.n ?? 0;
    // Never synced from this device: anything already here counts as a change.
    const localChanged = !!s.dirty || (s.baseVersion === undefined && localPeople > 0);
    const remote = await findFile(token);

    const push = async (id?: string) => {
      this.persist({ dirty: false });
      try {
        const f = await upload(token, db.exportFile(), id);
        this.persist({ fileId: f.id, baseVersion: f.version });
      } catch (e) {
        this.persist({ dirty: true });
        throw e;
      }
    };

    if (!remote) {
      if (localPeople === 0) return 'Nothing to upload yet. Add or import people, or sync the device that has them first.';
      await push();
      return `Uploaded ${localPeople} people to Google Drive.`;
    }
    if (remote.version === s.baseVersion && remote.id === s.fileId) {
      if (!localChanged) return 'Already up to date.';
      await push(remote.id);
      return 'Uploaded your changes.';
    }

    // Another device changed Drive since this one last synced.
    const bytes = await download(token, remote.id);
    const remotePeople = db.peopleIn(bytes);
    if (remotePeople === null) throw new Error('The copy in Google Drive isn’t a Personal CRM database.');
    let useRemote = !localChanged || localPeople === 0;
    if (localChanged && localPeople > 0 && remotePeople === 0) useRemote = false;
    else if (localChanged && localPeople > 0) {
      useRemote = confirm(
        `This device and Google Drive both changed since they last synced.\n\n` +
          `OK: use the Google Drive copy (${remotePeople} people).\n` +
          `Cancel: keep this device's copy (${localPeople} people) and replace the one in Drive.\n\n` +
          `The copy you don't keep is downloaded as a backup file first.`,
      );
      if (useRemote) downloadFile(db.exportFile(), `personal-crm-this-device-${isoDate()}.sqlite`);
      else downloadFile(bytes, `personal-crm-google-drive-${isoDate()}.sqlite`);
    }

    if (useRemote && !localChanged && this.saved.dirty) {
      // You changed something while the download ran: go round again and ask which copy to keep.
      this.again = true;
      return 'Checking again…';
    }
    if (!useRemote) {
      await push(remote.id);
      return 'Kept this device’s copy and uploaded it.';
    }
    this.pulling = true;
    try {
      await db.system(async () => {
        await db.importFile(bytes);
        await migrate(db);
      });
      await db.flush();
    } finally {
      this.pulling = false;
    }
    this.persist({ fileId: remote.id, baseVersion: remote.version, dirty: false });
    this.onReplaced();
    return `Downloaded the latest from Google Drive (${remotePeople} people).`;
  }
}

export const cloud = new CloudSync();

export function useCloud(): CloudState {
  return useSyncExternalStore(cloud.subscribe, cloud.getState);
}
