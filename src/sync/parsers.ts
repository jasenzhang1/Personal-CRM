/**
 * Parsers for contact exports. Websites can't read your phone's address book, and Instagram,
 * Facebook and LinkedIn don't let third-party apps read friend/connection lists through their
 * APIs — but every one of them lets you export your own data. These turn those files into Candidates.
 *
 * Keep this file free of imports so it can be unit-tested with plain `node --test`.
 */

export type SourceKind = 'phone' | 'google' | 'linkedin' | 'instagram' | 'facebook' | 'discord';

export interface Candidate {
  source: SourceKind;
  /** Stable identifier within the source (contact id, profile URL, username...). */
  externalId: string;
  name: string;
  handle?: string;
  phones?: string[];
  emails?: string[];
  /** 'MM-DD' or 'YYYY-MM-DD' */
  birthday?: string;
  /** When the connection was made, 'YYYY-MM-DD'. */
  connectedOn?: string;
  company?: string;
  title?: string;
  photo?: string;
}

export interface ParseResult {
  kind: SourceKind;
  candidates: Candidate[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isoFromTimestamp(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** LinkedIn writes dates like "15 Nov 2026". */
export function parseLinkedInDate(s: string): string | undefined {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s.trim());
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return `${m[3]}-${pad(month)}-${pad(Number(m[1]))}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return undefined;
}

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** LinkedIn → Settings → Data privacy → Get a copy of your data → Connections.csv */
export function parseLinkedIn(text: string): Candidate[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === 'First Name');
  if (headerIdx < 0) throw new Error('This does not look like a LinkedIn Connections.csv file.');
  const header = rows[headerIdx].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iFirst, iLast, iUrl, iEmail, iCompany, iPos, iOn] = [
    'First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On',
  ].map(col);

  const out: Candidate[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const name = `${get(iFirst)} ${get(iLast)}`.trim();
    if (!name) continue;
    const url = get(iUrl);
    const email = get(iEmail);
    out.push({
      source: 'linkedin',
      externalId: url || name.toLowerCase(),
      name,
      handle: url || undefined,
      emails: email ? [email] : undefined,
      company: get(iCompany) || undefined,
      title: get(iPos) || undefined,
      connectedOn: get(iOn) ? parseLinkedInDate(get(iOn)) : undefined,
    });
  }
  return out;
}

type IgItem = { title?: string; string_list_data?: { href?: string; value?: string; timestamp?: number }[] };

/**
 * Instagram → Accounts Center → Download your information → JSON.
 * Accepts followers_1.json (top-level array) and following.json / close_friends.json
 * (objects with a `relationships_*` array). Instagram exports have usernames, not real names.
 */
export function parseInstagram(json: unknown): Candidate[] {
  const items: IgItem[] = [];
  if (Array.isArray(json)) items.push(...(json as IgItem[]));
  else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) {
      if (k.startsWith('relationships_') && Array.isArray(v)) items.push(...(v as IgItem[]));
    }
  }
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of items) {
    const d = item.string_list_data?.[0];
    const fromHref = d?.href?.replace(/\/+$/, '').split('/').pop();
    const username = (d?.value || item.title || fromHref || '').trim();
    if (!username || seen.has(username.toLowerCase())) continue;
    seen.add(username.toLowerCase());
    out.push({
      source: 'instagram',
      externalId: username.toLowerCase(),
      name: username,
      handle: `@${username}`,
      connectedOn: d?.timestamp ? isoFromTimestamp(d.timestamp) : undefined,
    });
  }
  return out;
}

/**
 * Facebook JSON exports store UTF-8 bytes as individual \u00XX characters
 * ("JosÃ©" instead of "José"). Re-decode when the string looks like that.
 */
export function fixMojibake(s: string): string {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const b = s.charCodeAt(i);
    let cp: number;
    let n: number;
    if (b < 0x80) [cp, n] = [b, 0];
    else if ((b & 0xe0) === 0xc0) [cp, n] = [b & 0x1f, 1];
    else if ((b & 0xf0) === 0xe0) [cp, n] = [b & 0x0f, 2];
    else if ((b & 0xf8) === 0xf0) [cp, n] = [b & 0x07, 3];
    else return s;
    for (let k = 1; k <= n; k++) {
      const c = s.charCodeAt(i + k);
      if (Number.isNaN(c) || (c & 0xc0) !== 0x80) return s;
      cp = (cp << 6) | (c & 0x3f);
    }
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

/** Facebook → Download your information → JSON → connections/friends/your_friends.json */
export function parseFacebook(json: unknown): Candidate[] {
  const lists: unknown[] = [];
  if (Array.isArray(json)) lists.push(...json);
  else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) {
      if (/friends/i.test(k) && Array.isArray(v)) lists.push(...v);
    }
  }
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of lists as { name?: string; timestamp?: number }[]) {
    if (!f || typeof f.name !== 'string') continue;
    const name = fixMojibake(f.name).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      source: 'facebook',
      externalId: name.toLowerCase(),
      name,
      connectedOn: f.timestamp ? isoFromTimestamp(f.timestamp) : undefined,
    });
  }
  return out;
}

/** Give same-named entries distinct, stable ids: "sam lee", "sam lee#2", ... */
function nameKeys(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name) => {
    const k = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  };
}

function decodeQuotedPrintable(s: string): string {
  return fixMojibake(s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

const unescapeVcard = (s: string) => s.replace(/\\([nN,;\\:])/g, (_, c: string) => (c.toLowerCase() === 'n' ? '\n' : c));
const splitVcard = (s: string) => s.split(/(?<!\\);/).map((p) => unescapeVcard(p).trim());

/** vCard dates: 1990-07-04, 19900704, --0704, --07-04. Apple writes year 1604 for "no year". */
export function parseVcardDate(value: string, params = ''): string | undefined {
  const s = value.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return m[1] === '1604' || /X-APPLE-OMIT-YEAR/i.test(params) ? `${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = /^--(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}` : undefined;
}

/**
 * vCard PHOTO → something an <img> can show. iPhone/iCloud write
 * `PHOTO;ENCODING=b;TYPE=JPEG:<base64>`, vCard 4.0 writes a data: URI, Android 2.1 writes `;ENCODING=BASE64`.
 */
export function vcardPhoto(value: string, params: string): string | undefined {
  const v = value.trim();
  if (/^data:image\//i.test(v) || /^https:\/\//i.test(v)) return v.replace(/\s+/g, '');
  if (!/ENCODING=(b|BASE64)\b/i.test(params) && !/(^|;)BASE64(;|$)/i.test(params)) return undefined;
  const b64 = v.replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return undefined;
  const type = /(?:TYPE=)?(JPE?G|PNG|GIF|WEBP)\b/i.exec(params)?.[1].toLowerCase().replace('jpg', 'jpeg') ?? 'jpeg';
  return `data:image/${type};base64,${b64}`;
}

/**
 * vCard (.vcf) — what iPhone Contacts ("Share" all contacts), iCloud.com, Google Contacts
 * and Android all export. Handles vCard 2.1 (quoted-printable) through 4.0.
 */
export function parseVcards(text: string): Candidate[] {
  // Unfold continuation lines (RFC 6350 §3.2) and quoted-printable soft breaks.
  const lines: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) lines[lines.length - 1] = prev + line.slice(1);
    else if (prev !== undefined && prev.endsWith('=') && /QUOTED-PRINTABLE/i.test(prev.slice(0, prev.indexOf(':'))))
      lines[lines.length - 1] = prev.slice(0, -1) + line;
    else lines.push(line);
  }

  const key = nameKeys();
  const out: Candidate[] = [];
  let card: Record<string, { value: string; params: string }[]> | null = null;

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const [nameWithGroup, ...paramParts] = head.split(';');
    const prop = nameWithGroup.split('.').pop()!.toUpperCase();
    const params = paramParts.join(';');
    if (/QUOTED-PRINTABLE/i.test(params)) value = decodeQuotedPrintable(value);

    if (prop === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') card = {};
    else if (prop === 'END' && value.trim().toUpperCase() === 'VCARD' && card) {
      const first = (p: string) => card![p]?.[0];
      const n = first('N') ? splitVcard(first('N')!.value) : [];
      const name =
        unescapeVcard(first('FN')?.value ?? '').trim() ||
        [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(' ').trim() ||
        (first('ORG') ? splitVcard(first('ORG')!.value)[0] : '');
      const phones = (card.TEL ?? []).map((t) => t.value.replace(/^tel:/i, '').trim()).filter(Boolean);
      const emails = (card.EMAIL ?? []).map((e) => unescapeVcard(e.value).trim()).filter(Boolean);
      const display = name || phones[0] || emails[0];
      if (display) {
        const bday = first('BDAY');
        out.push({
          source: 'phone',
          externalId: first('UID')?.value.trim() || key(display),
          name: display,
          phones: phones.length ? phones : undefined,
          emails: emails.length ? emails : undefined,
          birthday: bday ? parseVcardDate(bday.value, bday.params) : undefined,
          company: first('ORG') ? splitVcard(first('ORG')!.value)[0] || undefined : undefined,
          title: first('TITLE') ? unescapeVcard(first('TITLE')!.value).trim() || undefined : undefined,
        });
        const photo = first('PHOTO') && vcardPhoto(first('PHOTO')!.value, first('PHOTO')!.params);
        if (photo) out[out.length - 1].photo = photo;
      }
      card = null;
    } else if (card) (card[prop] ??= []).push({ value, params });
  }
  return out;
}

/** Results from the browser Contact Picker API (Chrome on Android). */
export function fromContactPicker(results: { name?: string[]; tel?: string[]; email?: string[] }[]): Candidate[] {
  const key = nameKeys();
  return results
    .map((r) => {
      const name = r.name?.find(Boolean)?.trim() || r.tel?.[0] || r.email?.[0] || '';
      return { r, name };
    })
    .filter(({ name }) => name)
    .map(({ r, name }) => ({
      source: 'phone' as const,
      externalId: key(name),
      name,
      phones: r.tel?.filter(Boolean),
      emails: r.email?.filter(Boolean),
    }));
}

export type GooglePerson = {
  resourceName: string;
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  organizations?: { name?: string; title?: string }[];
  photos?: { url?: string; default?: boolean }[];
};

const AUTOMATED_EMAIL = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|alerts?|support|info|hello|team|news(letter)?|billing|receipts?|updates?)([._+-]|@)/i;

/**
 * Google People API results → candidates. `connections` are your saved Google Contacts;
 * `otherContacts` are people you've emailed in Gmail but never saved (automated senders are dropped).
 */
export function fromGooglePeople(people: GooglePerson[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of people) {
    const emails = (p.emailAddresses ?? []).map((e) => e.value?.trim()).filter((v): v is string => !!v);
    const phones = (p.phoneNumbers ?? []).map((e) => e.value?.trim()).filter((v): v is string => !!v);
    const isOther = p.resourceName.startsWith('otherContacts/');
    if (isOther && emails.length && emails.every((e) => AUTOMATED_EMAIL.test(e))) continue;
    const name = p.names?.[0]?.displayName?.trim() || emails[0] || phones[0];
    if (!name) continue;
    const b = p.birthdays?.find((x) => x.date?.month && x.date?.day)?.date;
    const md = b ? `${pad(b.month!)}-${pad(b.day!)}` : undefined;
    const photo = p.photos?.find((x) => x.url && !x.default)?.url;
    out.push({
      source: 'google',
      externalId: p.resourceName,
      name,
      emails: emails.length ? emails : undefined,
      phones: phones.length ? phones : undefined,
      birthday: md ? (b!.year ? `${b!.year}-${md}` : md) : undefined,
      company: p.organizations?.[0]?.name || undefined,
      title: p.organizations?.[0]?.title || undefined,
      photo,
    });
  }
  return out;
}

type DiscordRelationship = {
  id?: string;
  type?: number; // 1 = friend, 2 = blocked, 3/4 = pending requests
  nickname?: string | null;
  user?: { id?: string; username?: string; global_name?: string | null; discriminator?: string };
};

function looksLikeDiscord(json: unknown): boolean {
  const rels = (json as { relationships?: unknown })?.relationships;
  return Array.isArray(rels) && (rels.length === 0 || (typeof rels[0] === 'object' && rels[0] !== null && 'user' in rels[0]));
}

/**
 * Discord → User Settings → Data & Privacy → Request all of my data.
 * The package's Account/user.json lists your friends under `relationships`.
 */
export function parseDiscord(json: unknown): Candidate[] {
  const rels = ((json as { relationships?: DiscordRelationship[] }).relationships ?? []).filter((r) => (r.type ?? 1) === 1);
  const out: Candidate[] = [];
  for (const r of rels) {
    const u = r.user ?? {};
    const id = u.id ?? r.id;
    const username = u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username;
    const name = (r.nickname || u.global_name || u.username || '').trim();
    if (!id || !name) continue;
    out.push({ source: 'discord', externalId: id, name, handle: username ? `@${username}` : undefined });
  }
  return out;
}

/**
 * Which files inside an export .zip are worth reading. Everything else (photos, messages,
 * "removed_friends.json", ...) is skipped without being decompressed.
 */
export function isRelevantExportEntry(path: string): boolean {
  const base = path.split('/').pop()!.toLowerCase();
  // Instagram exports also include Threads followers/following (same people, different format).
  if (/(^|\/)threads\//i.test(path)) return false;
  return (
    base === 'connections.csv' ||
    /^followers(_\d+)?\.json$/.test(base) ||
    base === 'following.json' ||
    base === 'your_friends.json' ||
    base === 'friends.json' ||
    (base === 'user.json' && /(^|\/)account\//i.test(path)) ||
    base.endsWith('.vcf')
  );
}

export interface ParsedBatch {
  /** Candidates grouped by source and de-duplicated, ready to ingest once per source. */
  bySource: Map<SourceKind, Candidate[]>;
  files: { name: string; kind?: SourceKind; count?: number; error?: string }[];
}

/**
 * Parse several files at once (e.g. Instagram followers + following) and merge them per source,
 * so one import = one ingest per network. That keeps the "first import → Older connections"
 * rule from treating the second file of the same export as brand-new people.
 */
export function parseMany(entries: { name: string; text: string }[]): ParsedBatch {
  const bySource = new Map<SourceKind, Candidate[]>();
  const seen = new Map<SourceKind, Set<string>>();
  const files: ParsedBatch['files'] = [];
  for (const e of entries) {
    try {
      const r = parseExportFile(e.name, e.text);
      const list = bySource.get(r.kind) ?? [];
      const ids = seen.get(r.kind) ?? new Set();
      for (const c of r.candidates) {
        if (ids.has(c.externalId)) continue;
        ids.add(c.externalId);
        list.push(c);
      }
      bySource.set(r.kind, list);
      seen.set(r.kind, ids);
      files.push({ name: e.name, kind: r.kind, count: r.candidates.length });
    } catch (err) {
      files.push({ name: e.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { bySource, files };
}

function looksLikeInstagram(json: unknown): boolean {
  const first = Array.isArray(json)
    ? json[0]
    : json && typeof json === 'object'
      ? Object.entries(json).find(([k]) => k.startsWith('relationships_'))?.[1]
      : undefined;
  if (Array.isArray(json)) return !!first && typeof first === 'object' && 'string_list_data' in first;
  return first !== undefined;
}

/** Figure out which network a file came from and parse it. */
export function parseExportFile(fileName: string, text: string): ParseResult {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    const candidates = parseVcards(trimmed);
    if (!candidates.length) throw new Error(`No contacts found in ${fileName}.`);
    return { kind: 'phone', candidates };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Error(`${fileName} is not valid JSON.`);
    }
    if (looksLikeDiscord(json)) return { kind: 'discord', candidates: parseDiscord(json) };
    if (looksLikeInstagram(json)) return { kind: 'instagram', candidates: parseInstagram(json) };
    const fb = parseFacebook(json);
    if (fb.length) return { kind: 'facebook', candidates: fb };
    throw new Error(
      `Couldn't recognize ${fileName}. Pick Instagram's followers_1.json / following.json or Facebook's your_friends.json.`,
    );
  }
  return { kind: 'linkedin', candidates: parseLinkedIn(trimmed) };
}
