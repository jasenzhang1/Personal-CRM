import type { SQLiteDatabase } from '@/db/types';
import { replaceInteractions } from '@/db/ranking';
import type { ActivityDay } from '@/lib/ranking';
import type { ChatSource, ThreadActivity } from './messages';

export interface ChatImportResult {
  source: ChatSource;
  chats: number;
  matched: number;
  created: number;
  skipped: number;
  messages: number;
  calls: number;
  callSeconds: number;
}

/** Chats with someone not in your CRM become a new person once you've exchanged at least this many messages. */
export const MIN_MESSAGES_TO_ADD = 20;

const nameKey = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Link each one-on-one chat to a person and store its daily counts.
 * Matching, in order: a chat linked on an earlier import → Instagram username (thread folder) →
 * Discord user id → exactly one person with the same name. Busy chats with no match add a new person.
 */
export async function importChats(db: SQLiteDatabase, threads: ThreadActivity[]): Promise<ChatImportResult[]> {
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

      if (personId === undefined) {
        if (!th.otherName || th.messages + th.calls < MIN_MESSAGES_TO_ADD) {
          r.skipped++;
          continue;
        }
        const ins = await db.runAsync(
          `INSERT INTO people (name, status, created_at, updated_at) VALUES (?, 'backlog', ?, ?)`,
          th.otherName, t, t,
        );
        personId = ins.lastInsertRowId;
        byName.set(nameKey(th.otherName), [personId]);
        r.created++;
      } else r.matched++;

      // Remember the link so the next import of a newer export matches instantly.
      if (th.source !== 'discord') {
        await db.runAsync(
          'INSERT OR IGNORE INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, ?, ?, NULL, ?)',
          personId, th.source, chatKey, t,
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
    `${r.matched} matched to people`,
    r.created ? `${r.created} ${r.created === 1 ? 'person' : 'people'} you talk to added (Older connections)` : '',
    `${r.messages.toLocaleString()} messages`,
    r.calls ? `${r.calls} call${r.calls === 1 ? '' : 's'} (${hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(r.callSeconds / 60)} min`})` : '',
    r.skipped ? `${r.skipped} small chats skipped` : '',
  ].filter(Boolean);
  return `${label}: ${bits.join(' · ')}`;
}
