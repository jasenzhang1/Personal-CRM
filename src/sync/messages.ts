/**
 * Turn chat exports into "how much do we talk" counts. Message text is never kept: only how many
 * messages per day, how many calls, and how long the calls lasted.
 *
 * - Instagram / Facebook Messenger: messages/inbox/<thread>/message_N.json
 *   { participants: [{name}], messages: [{sender_name, timestamp_ms, content?, call_duration?}] }
 * - Discord: Messages/c<channel id>/channel.json + messages.json (or messages.csv in older packages).
 *   Only your own messages are in the package, so Discord counts are one-sided.
 */
import { isoDate } from '@/lib/dates';
import type { ActivityDay } from '@/lib/ranking';
import { fixMojibake, parseCsv } from './parsers';

export type ChatSource = 'instagram' | 'facebook' | 'discord';

export interface ThreadActivity {
  source: ChatSource;
  /** Stable id for the chat: the thread folder (Meta) or channel id (Discord). */
  threadId: string;
  /** The other person's display name (Meta), if known. */
  otherName?: string;
  /** The Discord user ids in the DM (includes yours). */
  recipientIds?: string[];
  days: ActivityDay[];
  messages: number;
  calls: number;
  callSeconds: number;
}

// Names may be a bare zip path ("Messages/c1/…") or "package.zip › Messages/c1/…" after unzipping.
const META_MSG = /(^|[/\s])messages\/inbox\/([^/]+)\/message_\d+\.json$/i;
const DISCORD_MSG = /(^|[/\s])messages\/(c?\d+)\/(channel\.json|messages\.json|messages\.csv)$/i;

/** Chat files worth reading inside an export .zip (message requests and group chats are skipped later). */
export const isMessageEntry = (path: string) => META_MSG.test(path) || DISCORD_MSG.test(path);

type Day = { messages: number; calls: number; call_seconds: number };
const bump = (m: Map<string, Day>, day: string, f: (d: Day) => void) => {
  const d = m.get(day) ?? { messages: 0, calls: 0, call_seconds: 0 };
  f(d);
  m.set(day, d);
};
const toDays = (m: Map<string, Day>): ActivityDay[] => [...m].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d }));

interface MetaFile {
  participants?: { name?: string }[];
  messages?: { sender_name?: string; timestamp_ms?: number; call_duration?: number }[];
}

export function parseChats(entries: { name: string; text: string }[]): ThreadActivity[] {
  return [...parseMetaChats(entries), ...parseDiscordChats(entries)];
}

function parseMetaChats(entries: { name: string; text: string }[]): ThreadActivity[] {
  // Group message_1.json, message_2.json… by thread.
  const threads = new Map<string, { source: ChatSource; folder: string; files: MetaFile[] }>();
  for (const e of entries) {
    const m = META_MSG.exec(e.name);
    if (!m) continue;
    let json: MetaFile;
    try {
      json = JSON.parse(e.text);
    } catch {
      continue;
    }
    const source: ChatSource = /instagram/i.test(e.name) ? 'instagram' : 'facebook';
    const key = `${source}:${m[2]}`;
    const t = threads.get(key) ?? { source, folder: m[2], files: [] };
    t.files.push(json);
    threads.set(key, t);
  }

  // "You" are whoever shows up in the most threads.
  const seen = new Map<string, number>();
  for (const t of threads.values()) {
    const names = new Set(t.files.flatMap((f) => f.participants ?? []).map((p) => fixMojibake(p.name ?? '')));
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const me = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0];

  const out: ThreadActivity[] = [];
  for (const t of threads.values()) {
    const names = [...new Set(t.files.flatMap((f) => f.participants ?? []).map((p) => fixMojibake(p.name ?? '')).filter(Boolean))];
    if (names.length !== 2) continue; // one-on-one chats only
    const other = names.find((n) => n !== me);
    if (!other) continue;
    const days = new Map<string, Day>();
    let messages = 0, calls = 0, callSeconds = 0;
    for (const f of t.files) {
      for (const msg of f.messages ?? []) {
        if (!msg.timestamp_ms) continue;
        const day = isoDate(new Date(msg.timestamp_ms));
        if (msg.call_duration !== undefined) {
          if (msg.call_duration > 0) {
            calls++;
            callSeconds += msg.call_duration;
            bump(days, day, (d) => {
              d.calls++;
              d.call_seconds += msg.call_duration!;
            });
          }
        } else {
          messages++;
          bump(days, day, (d) => d.messages++);
        }
      }
    }
    if (!days.size) continue;
    out.push({ source: t.source, threadId: t.folder, otherName: other, days: toDays(days), messages, calls, callSeconds });
  }
  return out;
}

function parseDiscordChats(entries: { name: string; text: string }[]): ThreadActivity[] {
  const channels = new Map<string, { recipients?: string[]; dm?: boolean; stamps: string[] }>();
  const get = (id: string) => {
    const c = channels.get(id) ?? { stamps: [] };
    channels.set(id, c);
    return c;
  };
  for (const e of entries) {
    const m = DISCORD_MSG.exec(e.name);
    if (!m) continue;
    const id = m[2].replace(/^c/i, '');
    const file = m[3].toLowerCase();
    try {
      if (file === 'channel.json') {
        const j = JSON.parse(e.text) as { type?: number | string; recipients?: unknown[] };
        const c = get(id);
        c.dm = j.type === 1 || j.type === 'DM';
        c.recipients = (j.recipients ?? []).map((r) => (typeof r === 'object' && r ? String((r as { id?: string }).id) : String(r)));
      } else if (file === 'messages.json') {
        const j = JSON.parse(e.text) as { Timestamp?: string; timestamp?: string }[];
        get(id).stamps.push(...j.map((x) => x.Timestamp ?? x.timestamp ?? '').filter(Boolean));
      } else {
        const rows = parseCsv(e.text);
        const ti = rows[0]?.findIndex((h) => /timestamp/i.test(h)) ?? -1;
        if (ti >= 0) get(id).stamps.push(...rows.slice(1).map((r) => r[ti]).filter(Boolean));
      }
    } catch {
      /* skip unreadable channel */
    }
  }
  const out: ThreadActivity[] = [];
  for (const [id, c] of channels) {
    if (!c.dm || !c.recipients?.length || !c.stamps.length) continue;
    const days = new Map<string, Day>();
    for (const s of c.stamps) {
      const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
      if (Number.isNaN(d.getTime())) continue;
      bump(days, isoDate(d), (x) => x.messages++);
    }
    if (!days.size) continue;
    out.push({ source: 'discord', threadId: id, recipientIds: c.recipients, days: toDays(days), messages: c.stamps.length, calls: 0, callSeconds: 0 });
  }
  return out;
}
