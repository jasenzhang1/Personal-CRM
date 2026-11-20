import { useSyncExternalStore } from 'react';
import type { BrowserDb } from '@/db/browser';
import { migrate } from '@/db/schema';
import { cachedToken, forgetToken, signIn, wantScopes } from '@/sync/google';
import { DRIVE_SCOPE, DriveAuthError, download, findFile, upload } from '@/sync/drive';
import { isoDate } from './dates';

/**
 * Keeps this device's database in step with one copy committed to a private GitHub repo, so your
 * phone and computer always show the same contacts. The whole database file is committed a couple
 * of seconds after every change, and other devices download it when you open or return to the app
 * (and every minute while it's open).
 *
 * Every commit is a version in GitHub's history, so nothing is ever lost. If two devices changed
 * things at the same time, the device you're using wins and the other version stays in history.
 *
 * Sync settings live in localStorage, not in the database, because syncing replaces the database.
 */

export type CloudStatus = 'off' | 'idle' | 'syncing' | 'error';

export interface CloudState {
  enabled: boolean;
  /** "owner/repo" of the data repo. */
  repo: string;
  status: CloudStatus;
  error: string | null;
  /** ISO time of the last successful sync on this device. */
  lastSync: string | null;
  /** Changes on this device that aren't on GitHub yet. */
  pending: boolean;
  /** What the last sync did, for the settings page. */
  lastAction: string | null;
}

interface Saved {
  enabled?: boolean;
  repo?: string;
  branch?: string;
  token?: string;
  /** GitHub's blob SHA of the file when this device last matched it. */
  baseSha?: string;
  dirty?: boolean;
  lastSync?: string;
}

const KEY = 'crm.github';
const PUSH_DELAY = 1500;
/** Check GitHub for other devices' changes when coming back to the app, at most this often. */
const PULL_EVERY = 15_000;
/** And while the app stays open and visible. */
const POLL_EVERY = 60_000;

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'browser';
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
      repo: s.repo ?? '',
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
      this.set(this.state.status === 'error' ? 'idle' : this.state.status);
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => void this.sync(), PUSH_DELAY);
    };
    document.addEventListener('visibilitychange', () => {
      if (!this.saved.enabled) return;
      if (document.visibilityState === 'visible' && Date.now() - this.lastCheck > PULL_EVERY) void this.sync();
      // Leaving the app (switching apps on the phone, closing the tab): upload now, don't wait.
      if (document.visibilityState === 'hidden' && this.saved.dirty) void this.sync();
    });
    addEventListener('pagehide', () => this.saved.enabled && this.saved.dirty && void this.sync());
    addEventListener('online', () => this.saved.enabled && void this.sync());
    setInterval(() => {
      if (this.saved.enabled && document.visibilityState === 'visible' && Date.now() - this.lastCheck > POLL_EVERY) void this.sync();
    }, 10_000);
    this.set('idle');
    if (this.saved.enabled) void this.sync();
  }

  /** Connect to a data repo ("owner/repo") with a token, then sync. */
  async connect(repoFull: string, token: string) {
    const [owner, repo] = repoFull.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
    if (!owner || !repo) throw new Error('Enter the repo as owner/name, like jasen/personal-crm-data.');
    const r = await checkRepo(token.trim(), owner, repo);
    const sameRepo = this.saved.repo === `${r.owner}/${r.repo}`;
    this.persist({
      enabled: true,
      repo: `${r.owner}/${r.repo}`,
      branch: r.branch,
      token: token.trim(),
      ...(sameRepo ? {} : { baseSha: undefined }),
    });
    await this.sync();
  }

  disable() {
    this.persist({ enabled: false });
    this.set('off', null, null);
  }

  /** Setup link for another device: carries the repo and token in the URL hash (never sent to any server). */
  setupLink(): string {
    const s = this.saved;
    const q = new URLSearchParams({ ghrepo: s.repo ?? '', ghtoken: s.token ?? '' });
    return `${location.origin}${location.pathname}#/sync?${q}`;
  }

  /** A restore from a backup file should replace what's on GitHub too. */
  markChanged() {
    if (this.db?.drafting) return; // pressing Save uploads it
    this.db?.onWrite();
  }

  /** Sync now. */
  sync(): Promise<void> {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
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

  private async run() {
    const db = this.db;
    if (!db || !this.saved.enabled) return;
    // A download would replace what you're editing. Pressing Save syncs.
    if (db.drafting) return;
    const r = this.repo();
    const token = this.saved.token;
    if (!r || !token) return this.set('error', 'Connect your GitHub data repo first.');
    if (!navigator.onLine) return this.set('error', 'You’re offline. Changes will upload when you’re back online.');
    this.set('syncing');
    try {
      this.lastCheck = Date.now();
      const action = await this.exchange(db, token, r);
      this.persist({ lastSync: new Date().toISOString() });
      this.set('idle', null, action);
    } catch (e) {
      if (e instanceof DriveAuthError) {
        forgetToken();
        return this.set('signin', interactive ? e.message : null);
      }
      if (!(e instanceof GitHubAuthError)) setTimeout(() => this.saved.dirty && void this.sync(), 30_000);
      console.error('GitHub sync failed', e);
      this.set('error', e instanceof Error ? e.message : String(e));
    }
  }

  private async exchange(db: BrowserDb, token: string, r: GhRepo): Promise<string> {
    const s = this.saved;
    const localPeople = (await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM people'))?.n ?? 0;
    // Never synced from this device: anything already here counts as a change.
    const localChanged = !!s.dirty || (s.baseSha === undefined && localPeople > 0);
    const remote = await findFile(token, r);

    const push = async (sha?: string) => {
      this.persist({ dirty: false });
      try {
        await db.flush();
        const f = await upload(token, r, db.exportFile(), `Update CRM from ${deviceName()} (${localPeople} people)`, sha);
        this.persist({ baseSha: f.sha });
      } catch (e) {
        this.persist({ dirty: true });
        throw e;
      }
    };

    if (!remote) {
      if (localPeople === 0) return 'Nothing to upload yet. Add or import people, or connect the device that has them first.';
      await push();
      return `Uploaded ${localPeople} people to GitHub.`;
    }
    if (remote.sha === s.baseSha) {
      if (!localChanged) return 'Up to date.';
      await push(remote.sha);
      return 'Committed your changes to GitHub.';
    }

    // Another device committed since this one last synced.
    if (s.baseSha === undefined && localPeople > 0) {
      // First time this device connects and both sides have data: GitHub's copy wins, but this
      // device's copy is committed first so it stays in history, then GitHub's copy is put back on top.
      const bytes = await download(token, r);
      if (db.peopleIn(bytes) === null) throw new Error('The file on GitHub isn’t a Personal CRM database.');
      const mine = await upload(token, r, db.exportFile(), `Snapshot of ${deviceName()} before it first synced (${localPeople} people)`, remote.sha);
      const back = await upload(token, r, bytes, `Restore latest after ${deviceName()} connected`, mine.sha);
      return this.replace(db, bytes, back.sha);
    }
    if (localChanged && localPeople > 0) {
      // Both changed: keep what you just did here. The other version stays in the repo's history.
      await push(remote.sha);
      return 'Committed this device’s copy. The other device’s version is still in GitHub history.';
    }
    const bytes = await download(token, r);
    const remotePeople = db.peopleIn(bytes);
    if (remotePeople === null) throw new Error('The file on GitHub isn’t a Personal CRM database.');
    if (this.saved.dirty) {
      // You changed something while the download ran: go round again.
      this.again = true;
      return 'Checking again…';
    }
    return this.replace(db, bytes, remote.sha);
  }

  private async replace(db: BrowserDb, bytes: Uint8Array, sha: string): Promise<string> {
    const remotePeople = db.peopleIn(bytes) ?? 0;
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
    this.persist({ baseSha: sha, dirty: false });
    this.onReplaced();
    return `Downloaded the latest from GitHub (${remotePeople} people).`;
  }
}

export const cloud = new CloudSync();

export function useCloud(): CloudState {
  return useSyncExternalStore(cloud.subscribe, cloud.getState);
}
