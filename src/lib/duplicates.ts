/**
 * Finding people who are probably the same person, e.g. an Instagram follower "jackiezhang26"
 * and a chat contact "Jackie Zhang", or the same friend imported from your phone and Facebook
 * under slightly different spellings.
 */
import { looksStandard, suggestName } from './names';

export interface DupSource {
  source: string;
  external_id: string;
  handle: string | null;
  display_name: string | null;
}
export interface DupPerson {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  sources: DupSource[];
}

export type DupReason = 'same-contact' | 'chat-name' | 'same-name' | 'username' | 'suggested' | 'initial';
export interface DupPair {
  a: number;
  b: number;
  reason: DupReason;
  strong: boolean;
}

export const DUP_REASONS: Record<DupReason, string> = {
  'same-contact': 'Same email or phone number',
  'chat-name': 'Same name they use on Instagram or in chats',
  'same-name': 'Same name',
  username: 'Username matches their name',
  suggested: 'Cleaned-up username matches their name',
  initial: 'Username is first initial + last name',
};

/** "José  Álvarez" → "jose alvarez" */
export const nameKey = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
/** letters only: "Jackie Zhang" → "jackiezhang", "jackie.zhang_26" → "jackiezhang" */
const compact = (s: string) => nameKey(s).replace(/\s/g, '');
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);

/** Usernames (Instagram etc.), not chat links. */
const usernamesOf = (p: DupPerson) =>
  p.sources.filter((s) => !s.external_id.startsWith('chat:') && s.handle && !/^https?:/.test(s.handle)).map((s) => s.handle!.replace(/^@/, ''));
/** Two different Instagram accounts are more likely two people than one. */
const igAccounts = (p: DupPerson) => new Set(p.sources.filter((s) => s.source === 'instagram' && !s.external_id.startsWith('chat:')).map((s) => s.external_id));
const differentAccounts = (x: DupPerson, y: DupPerson) => {
  const a = igAccounts(x);
  const b = igAccounts(y);
  return a.size > 0 && b.size > 0 && ![...a].some((id) => b.has(id));
};

export function findDuplicates(people: DupPerson[], dismissed: Set<string> = new Set()): DupPair[] {
  const out = new Map<string, DupPair>();
  const add = (x: number, y: number, reason: DupReason, strong: boolean) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = pairKey(a, b);
    if (dismissed.has(key)) return;
    // Several rules can match the same pair: keep the most convincing reason.
    const prev = out.get(key);
    if (prev && (Number(prev.strong) > Number(strong) || (prev.strong === strong && ORDER.indexOf(prev.reason) <= ORDER.indexOf(reason)))) return;
    out.set(key, { a, b, reason, strong });
  };
  const byId = new Map(people.map((p) => [p.id, p]));

  // Index by full name and by squashed-together name.
  const byName = new Map<string, number[]>();
  const byCompact = new Map<string, number[]>();
  for (const p of people) {
    const k = nameKey(p.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), p.id]);
    if (k.includes(' ')) byCompact.set(compact(p.name), [...(byCompact.get(compact(p.name)) ?? []), p.id]);
  }

  // 1. Same email or phone (imports already merge most of these; this catches hand-made copies).
  const byContact = new Map<string, number[]>();
  for (const p of people) {
    for (const key of [p.email?.trim().toLowerCase(), digits(p.phone).length >= 7 ? digits(p.phone) : '']) {
      if (key) byContact.set(key, [...(byContact.get(key) ?? []), p.id]);
    }
  }
  for (const ids of byContact.values()) for (let i = 1; i < ids.length; i++) add(ids[0], ids[i], 'same-contact', true);

  for (const p of people) {
    // 2. Someone's chat name is exactly another person's name.
    for (const s of p.sources) {
      if (!s.display_name) continue;
      // A lone first name ("Stephen") is too common to be sure about.
      const full = nameKey(s.display_name).includes(' ');
      for (const other of byName.get(nameKey(s.display_name)) ?? []) add(p.id, other, 'chat-name', full);
    }

    const users = usernamesOf(p);
    // 3. Username = someone's name squashed together ("jackiezhang26" ↔ "Jackie Zhang").
    for (const u of users) {
      const cu = compact(u);
      if (cu.length < 5) continue;
      for (const [cn, ids] of byCompact) {
        if (cn.length < 6) continue;
        if (usernameHasName(cu, cn)) for (const other of ids) if (!differentAccounts(p, byId.get(other)!)) add(p.id, other, 'username', true);
      }
    }

    // 4. The cleaned-up version of a username-ish name matches someone ("lydiiiaaa.lu" → Lydia Lu).
    if (!looksStandard(p.name)) {
      const s = suggestName({ name: p.name, usernames: users });
      if (s && looksStandard(s.name)) for (const other of byName.get(nameKey(s.name)) ?? []) if (!differentAccounts(p, byId.get(other)!)) add(p.id, other, 'suggested', false);
    }
  }

  // 5. Exactly the same name. Single first names ("Kevin") only when it's a pair, not a crowd.
  for (const [k, ids] of byName) {
    if (ids.length < 2) continue;
    const full = k.includes(' ');
    if (!full && ids.length > 2) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], 'same-name', full && !differentAccounts(byId.get(ids[i])!, byId.get(ids[j])!));
  }

  // 6. "jsmith" ↔ "John Smith": first initial + last name.
  const byInitial = new Map<string, number[]>();
  for (const p of people) {
    const words = nameKey(p.name).split(' ');
    if (words.length < 2 || words[words.length - 1].length < 3) continue;
    const key = words[0][0] + words[words.length - 1];
    byInitial.set(key, [...(byInitial.get(key) ?? []), p.id]);
  }
  for (const p of people) {
    for (const u of usernamesOf(p)) {
      const ids = byInitial.get(compact(u));
      if (ids && ids.length === 1 && !differentAccounts(p, byId.get(ids[0])!)) add(p.id, ids[0], 'initial', false);
    }
  }

  return [...out.values()].sort((x, y) => Number(y.strong) - Number(x.strong) || ORDER.indexOf(x.reason) - ORDER.indexOf(y.reason));
}

const ORDER: DupReason[] = ['same-contact', 'chat-name', 'username', 'same-name', 'suggested', 'initial'];

/**
 * Does a squashed username contain this squashed name as its own piece? Allows wrappers like
 * "notarthurzhou", "darrenlinsta", "nataliewucomedy" but not "kellylin" for Kelly Li (the n
 * makes a different last name) or "senyoungkim" for Young Kim (it's part of a longer first name).
 */
const WRAPPERS = ['its', 'not', 'the', 'im', 'iam', 'real', 'official', 'x', 'xx', 'hey', 'yo'];
function usernameHasName(cu: string, cn: string): boolean {
  if (cu === cn) return true;
  if (cn.length < 7) return false;
  for (const pre of ['', ...WRAPPERS]) {
    if (!cu.startsWith(pre + cn)) continue;
    const rest = cu.length - pre.length - cn.length;
    if (rest === 0 || rest >= 3) return true;
  }
  return false;
}

export const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
