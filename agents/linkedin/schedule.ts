/** When to ask LinkedIn for a new archive, and which downloads are new. Kept pure so it's testable. */
import type { PageState } from './browser.ts';

export interface LinkedInState {
  lastRunAt: string;
  lastStatus: string;
  lastMessage: string;
  lastRequestAt: string;
  lastImportAt: string;
  /** SHA-256 of every archive already imported, so the same archive is never imported twice. */
  imported: string[];
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Ask for a new archive when LinkedIn allows one (Request button, nothing in progress) and the
 * last request was at least `everyDays` ago. An hour of slack keeps a daily task from slipping
 * to every other day when it runs a few minutes early.
 */
export function requestDue(page: PageState, state: Partial<LinkedInState>, now: Date, everyDays: number): boolean {
  if (page.signedOut || page.pending || !page.requestable) return false;
  if (!state.lastRequestAt) return true;
  return now.getTime() - new Date(state.lastRequestAt).getTime() >= everyDays * DAY - 60 * 60 * 1000;
}

export const isNew = (sha256: string, state: Partial<LinkedInState>) => !(state.imported ?? []).includes(sha256);
