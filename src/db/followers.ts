import type { SQLiteDatabase } from './types';
import { getSetting } from './people';

export interface FollowAccount {
  username: string;
  display: string | null;
  follows_me: number;
  i_follow: number;
  follows_me_since: string | null;
  i_follow_since: string | null;
  /** The person in your CRM with this Instagram account, if any. */
  person_id: number | null;
  name: string | null;
  photo: string | null;
  status: string | null;
}
export interface FollowEvent extends FollowAccount {
  kind: 'followed_me' | 'unfollowed_me' | 'i_followed' | 'i_unfollowed';
  at: string | null;
  after: string | null;
}

const JOIN = `LEFT JOIN sources s ON s.source = 'instagram' AND s.external_id = a.username
              LEFT JOIN people p ON p.id = s.person_id`;

export function listFollowAccounts(db: SQLiteDatabase) {
  return db.getAllAsync<FollowAccount>(`SELECT a.*, p.id AS person_id, p.name, p.photo, p.status FROM ig_accounts a ${JOIN}`);
}

export function listFollowEvents(db: SQLiteDatabase) {
  return db.getAllAsync<FollowEvent>(
    `SELECT e.kind, e.at, e.after, a.*, p.id AS person_id, p.name, p.photo, p.status
     FROM ig_events e JOIN ig_accounts a ON a.username = e.username ${JOIN}
     ORDER BY e.at DESC, e.id DESC`,
  );
}

export async function followExportDates(db: SQLiteDatabase) {
  return { followers: await getSetting(db, 'ig_followers_export'), following: await getSetting(db, 'ig_following_export') };
}
