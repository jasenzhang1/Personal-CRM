import { useSyncExternalStore } from 'react';
import type { BrowserDb } from '@/db/browser';
import { getSetting, setSetting } from '@/db/people';
import { applyNameSuggestions, AUTO_NAMES_KEY } from '@/db/names';
import { cachedToken, CONTACT_SCOPES, fetchSavedContacts, GoogleAuthError, loadGis, signIn, wantScopes } from '@/sync/google';
import { ingest } from '@/sync/ingest';
import { cloud } from './cloud';

/**
 * Brings new phone contacts into the Inbox without importing anything by hand.
 *
 * A website can't read your iPhone's contacts, but your iPhone can save every new contact to your
 * Gmail account, and this app can read Google Contacts. So once that's set up, a contact you add on
 * your phone reaches Google within a minute, and this checks Google whenever you open the app:
 *
 * - quietly, at most every few minutes, while a Google sign-in from the last hour is still good;
 * - otherwise, once a day, a bar asks for one tap (Google sign-in can only open from a tap). That
 *   same tap is all it takes.
 *
 * Only saved contacts are checked, not everyone you've emailed, so the Inbox stays about people.
 * The setting lives in the database, so it follows GitHub sync to your other devices, and
 * the last-check time is shared too, so two devices don't both ask.
 */

export const AUTO_KEY = 'auto_contacts';
const LAST_KEY = 'last_sync_google';
/** Check quietly (no sign-in needed) at most this often. */
export const QUIET_EVERY = 5 * 60_000;
/** Ask for a tap when it hasn't checked for this long. */
export const ASK_EVERY = 20 * 3600_000;

export type AutoStatus = 'off' | 'idle' | 'checking' | 'signin' | 'error';

export interface AutoState {
  enabled: boolean;
  status: AutoStatus;
  error: string | null;
  /** ISO time of the last check (from any device). */
  lastCheck: string | null;
  /** People the last check added to the Inbox, for the "new from your phone" bar. */
  arrived: { id: number; name: string }[];
  /** The first check filed everyone already in Google under Older connections. */
  baseline: boolean;
}

/** What a check should do now: run quietly, ask for a tap, or nothing. */
export function nextStep(lastCheck: string | null, hasToken: boolean, now = Date.now()): 'run' | 'ask' | 'wait' {
  const since = lastCheck ? now - Date.parse(lastCheck) : Infinity;
  if (hasToken) return since >= QUIET_EVERY ? 'run' : 'wait';
  return since >= ASK_EVERY ? 'ask' : 'wait';
}

class AutoContacts {
  private db: BrowserDb | null = null;
  private onChange: () => void = () => {};
  private running: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private state: AutoState = { enabled: false, status: 'off', error: null, lastCheck: null, arrived: [], baseline: false };

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;

  private set(patch: Partial<AutoState>) {
    this.state = { ...this.state, ...patch };
    if (!this.state.enabled) this.state.status = 'off';
    this.listeners.forEach((l) => l());
  }

  /** Hook up to the open database. `onChange` refreshes the screens after new people arrive. */
  start(db: BrowserDb, onChange: () => void) {
    this.db = db;
    this.onChange = onChange;
    cloud.onSynced = () => void this.check(false); // a GitHub download may have turned it on or brought a newer check time
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void this.check(false));
    addEventListener('online', () => void this.check(false));
    setInterval(() => document.visibilityState === 'visible' && void this.check(false), 60_000);
    void this.check(false);
  }

  async setEnabled(on: boolean) {
    const db = this.db;
    if (!db) return;
    await setSetting(db, AUTO_KEY, on ? '1' : '0');
    this.onChange();
    if (on) await this.check(true);
    else {
      wantScopes('contacts', null);
      this.set({ enabled: false, error: null });
    }
  }

  dismissArrived() {
    this.set({ arrived: [], baseline: false });
  }

  /** Check Google for new contacts if it's time. `interactive` (from a tap) may open Google's sign-in, and always checks. */
  check(interactive: boolean): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(interactive).finally(() => (this.running = null));
    return this.running;
  }

  private async run(interactive: boolean) {
    const db = this.db;
    if (!db) return;
    const enabled = (await getSetting(db, AUTO_KEY)) === '1';
    wantScopes('contacts', enabled ? CONTACT_SCOPES : null);
    const lastCheck = await getSetting(db, LAST_KEY);
    this.set({ enabled, lastCheck });
    if (!enabled) return;
    const clientId = await getSetting(db, 'google_client_id');
    if (!clientId) return this.set({ status: 'error', error: 'Set up “Sync with Google” on Import & settings first.' });
    // Load Google's sign-in script ahead of time: a popup opened after a slow download gets blocked.
    void loadGis().catch(() => {});
    // New people would land in your unsaved edits (and vanish on Discard). Check after you Save.
    if (db.drafting) return;
    if (!navigator.onLine) return;

    let token = cachedToken(CONTACT_SCOPES);
    const step = interactive ? 'run' : nextStep(lastCheck, !!token);
    if (step === 'wait') return this.state.status === 'checking' ? this.set({ status: 'idle' }) : undefined;
    if (step === 'ask') return this.set({ status: 'signin', error: null });

    this.set({ status: 'checking', error: null });
    try {
      token ??= await signIn(clientId, CONTACT_SCOPES);
      // Let GitHub sync catch up first, so new people go onto the latest copy.
      await cloud.idle();
      const candidates = await fetchSavedContacts(token);
      if (db.drafting) return this.set({ status: 'idle' });
      const before = (await db.getFirstAsync<{ n: number }>('SELECT coalesce(max(id), 0) AS n FROM people'))?.n ?? 0;
      const result = await db.system(async () => {
        const r = await ingest(db, 'google', candidates);
        if (r.added && (await getSetting(db, AUTO_NAMES_KEY)) !== '0') await applyNameSuggestions(db);
        return r;
      });
      const arrived = await db.getAllAsync<{ id: number; name: string }>("SELECT id, name FROM people WHERE id > ? AND status = 'new' ORDER BY id", before);
      this.set({
        status: 'idle',
        lastCheck: (await getSetting(db, LAST_KEY)) ?? new Date().toISOString(),
        arrived: arrived.length ? [...this.state.arrived.filter((a) => !arrived.some((b) => b.id === a.id)), ...arrived] : this.state.arrived,
        baseline: result.baseline || this.state.baseline,
      });
      this.onChange();
    } catch (e) {
      if (e instanceof GoogleAuthError) return this.set({ status: 'signin', error: null });
      console.error('Checking for new contacts failed', e);
      this.set({ status: interactive ? 'error' : 'signin', error: interactive ? (e instanceof Error ? e.message : String(e)) : null });
    }
  }
}

export const autoContacts = new AutoContacts();

export function useAutoContacts(): AutoState {
  return useSyncExternalStore(autoContacts.subscribe, autoContacts.getState);
}
