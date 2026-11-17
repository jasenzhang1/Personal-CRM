import type { SQLiteDatabase } from '@/db/types';
import { replaceInteractions } from '@/db/ranking';
import type { ActivityDay } from '@/lib/ranking';
import type { ChatSource, ThreadActivity } from './messages';
import { usernameSpellsName } from '@/lib/duplicates';

export interface ChatImportResult {
  source: ChatSource;
  chats: number;
  matched: number;
  created: number;
  skipped: number;
  messages: number;
  calls: number;
  callSeconds: number;
  /** Matched to an Instagram follower because their username or Instagram name fits the chat name. */
  linkedToFollower?: number;
}


const nameKey = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Link each one-on-one chat to a person and store its daily counts.
 * Matching, in order: a chat linked on an earlier import → Instagram username (thread folder) →
 * Discord user id → exactly one person with the same name. Busy chats with no match add a new person.
 */
export async function importChats(db: SQLiteDatabase, threads: ThreadActivity[]): Promise<ChatImportResult[]> {
  // Instagram followers/following, to attach a chat to the follower it belongs to instead of
  // creating a second copy of that person (chats only include display names, not usernames).
  const igAccounts = await db.getAllAsync<{ person_id: number; external_id: string; display_name: string | null }>(
    "SELECT person_id, external_id, display_name FROM sources WHERE source = 'instagram' AND external_id NOT LIKE 'chat:%'",
  );
  const followerFor = (name: string): number | undefined => {
    const ids = new Set(
      igAccounts
        .filter((a) => (a.display_name && nameKey(a.display_name) === nameKey(name)) || usernameSpellsName(a.external_id, name))
        .map((a) => a.person_id),
    );
    return ids.size === 1 ? [...ids][0] : undefined; // only when it's clearly one person
  };
  const people = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM people');
  const sources = await db.getAllAsync<{ person_id: number; source: string; external_id: string }>('SELECT person_id, source, external_id FROM sources');
  const bySource = new Map(sources.map((s) => [`${s.source}:${s.external_id.toLowerCase()}`, s.person_id]));
  const byName = new Map<string, number[]>();
  for (const p of people) byName.set(nameKey(p.name), [...(byName.get(nameKey(p.name)) ?? []), p.id]);

  const results = new Map<ChatSource, ChatImportResult>();
  const perSource = new Map<ChatSource, Map<number, ActivityDay[]>>();
  const t = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    for (const th of threads) {
      const r = results.get(th.source) ?? { source: th.source, chats: 0, matched: 0, created: 0, skipped: 0, messages: 0, calls: 0, callSeconds: 0 };
      results.set(th.source, r);
      r.chats++;
      const chatKey = `chat:${th.threadId}`.toLowerCase();

      let personId =
        bySource.get(`${th.source}:${chatKey}`) ??
        (th.source === 'instagram' ? bySource.get(`instagram:${th.threadId.replace(/_\d+$/, '').toLowerCase()}`) : undefined) ??
        th.recipientIds?.map((id) => bySource.get(`discord:${id}`)).find((x) => x !== undefined);
      if (personId === undefined && th.otherName) {
        const same = byName.get(nameKey(th.otherName)) ?? [];
        if (same.length === 1) personId = same[0];
      }
      if (personId === undefined && th.source === 'instagram' && th.otherName) {
        personId = followerFor(th.otherName);
        if (personId !== undefined) r.linkedToFollower = (r.linkedToFollower ?? 0) + 1;
      }

      // Chats only add message counts to people already in your list. They never create people:
      // chats don't include usernames, so such a person would have no profile link.
      if (personId === undefined) {
        r.skipped++;
        continue;
      }
      r.matched++;

      // Remember the link so the next import of a newer export matches instantly.
      if (th.source !== 'discord') {
        await db.runAsync(
          `INSERT INTO sources (person_id, source, external_id, handle, display_name, first_seen) VALUES (?, ?, ?, NULL, ?, ?)
           ON CONFLICT (source, external_id) DO UPDATE SET display_name = excluded.display_name`,
          personId, th.source, chatKey, th.otherName ?? null, t,
        );
        bySource.set(`${th.source}:${chatKey}`, personId);
      }

      r.messages += th.messages;
      r.calls += th.calls;
      r.callSeconds += th.callSeconds;
      const map = perSource.get(th.source) ?? new Map<number, ActivityDay[]>();
      map.set(personId, mergeDays(map.get(personId) ?? [], th.days));
      perSource.set(th.source, map);
    }
  });

  for (const [source, map] of perSource) await replaceInteractions(db, source, map);
  return [...results.values()];
}

function mergeDays(a: ActivityDay[], b: ActivityDay[]): ActivityDay[] {
  const m = new Map(a.map((d) => [d.day, { ...d }]));
  for (const d of b) {
    const x = m.get(d.day);
    if (x) {
      x.messages += d.messages;
      x.calls += d.calls;
      x.call_seconds += d.call_seconds;
    } else m.set(d.day, { ...d });
  }
  return [...m.values()].sort((x, y) => x.day.localeCompare(y.day));
}

export function describeChats(r: ChatImportResult): string {
  const label = { instagram: 'Instagram chats', facebook: 'Messenger chats', discord: 'Discord DMs' }[r.source];
  const hours = r.callSeconds / 3600;
  const bits = [
    `${r.chats} one-on-one chats`,
    `${r.matched} matched to people${r.linkedToFollower ? ` (${r.linkedToFollower} by their Instagram username)` : ''}`,

    `${r.messages.toLocaleString()} messages`,
    r.calls ? `${r.calls} call${r.calls === 1 ? '' : 's'} (${hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(r.callSeconds / 60)} min`})` : '',
    r.skipped ? `${r.skipped} with people not in your list skipped` : '',
  ].filter(Boolean);
  return `${label}: ${bits.join(' · ')}`;
}
