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
  /** City they live in, from a contact address. */
  city?: string;
  /** Old uploaded address books: file under Older connections, never the Inbox. */
  quiet?: boolean;
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
        const city = vcardCity(card.ADR ?? []);
        if (city) out[out.length - 1].city = city;
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
  addresses?: { city?: string; region?: string; type?: string }[];
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
      ...(googleCity(p.addresses) ? { city: googleCity(p.addresses) } : {}),
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
    // Newer exports include when you became friends.
    const since = typeof (r as { since?: unknown }).since === 'string' ? ((r as { since: string }).since.slice(0, 10)) : undefined;
    out.push({ source: 'discord', externalId: id, name, handle: username ? `@${username}` : undefined, ...(since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? { connectedOn: since } : {}) });
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
    base === 'your_friends.html' ||
    base === 'friends.html' ||
    base === 'your_address_books.json' ||
    base === 'synced_contacts.json' ||
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
  if (/^<(!doctype|html)/i.test(trimmed)) {
    const fb = parseFacebookFriendsHtml(trimmed);
    if (fb.length) return { kind: 'facebook', candidates: fb };
    throw new Error(`Couldn't find friends in ${fileName}. If this is a Facebook export, request it again in JSON format.`);
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Error(`${fileName} is not valid JSON.`);
    }
    if (looksLikeDiscord(json)) return { kind: 'discord', candidates: parseDiscord(json) };
    const book = parseAddressBook(json);
    if (book) {
      if (!book.length) throw new Error(`${fileName}: the address book is empty.`);
      return { kind: 'phone', candidates: book };
    }
    if (looksLikeInstagram(json)) return { kind: 'instagram', candidates: parseInstagram(json) };
    const fb = parseFacebook(json);
    if (fb.length) return { kind: 'facebook', candidates: fb };
    throw new Error(
      `Couldn't recognize ${fileName}. Pick Instagram's followers_1.json / following.json or Facebook's your_friends.json.`,
    );
  }
  return { kind: 'linkedin', candidates: parseLinkedIn(trimmed) };
}

/** "Los Angeles" + "CA" → "Los Angeles, CA". Short regions (states, provinces) are kept; long ones dropped. */
export function formatCity(city?: string, region?: string): string | undefined {
  const c = city?.trim();
  if (!c) return undefined;
  const r = region?.trim();
  return r && r.length <= 3 && !c.includes(',') ? `${c}, ${r.toUpperCase()}` : c;
}

/** vCard ADR = PO box;extended;street;city;region;postal code;country. Prefers a HOME address. */
function vcardCity(adrs: { value: string; params: string }[]): string | undefined {
  const sorted = [...adrs].sort((a, b) => Number(/home/i.test(b.params)) - Number(/home/i.test(a.params)));
  for (const a of sorted) {
    const parts = splitVcard(a.value).map((p) => unescapeVcard(p).trim());
    const city = formatCity(parts[3], parts[4]);
    if (city) return city;
  }
  return undefined;
}

function googleCity(addresses?: { city?: string; region?: string; type?: string }[]): string | undefined {
  const sorted = [...(addresses ?? [])].sort((a, b) => Number(b.type === 'home') - Number(a.type === 'home'));
  for (const a of sorted) {
    const city = formatCity(a.city, a.region);
    if (city) return city;
  }
  return undefined;
}

/* ---------------- Facebook in HTML format ---------------- */

const decodeEntities = (t: string) =>
  t
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const FB_DATE = /^([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/;
const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fbDate(t: string): string | undefined {
  const m = FB_DATE.exec(t);
  if (!m) return undefined;
  const [mon, day, year] = m[1].replace('.', '').replace(',', '').split(' ');
  const i = MONTHS3.indexOf(mon.slice(0, 3).toLowerCase());
  return i < 0 ? undefined : `${year}-${pad(i + 1)}-${pad(Number(day))}`;
}

/**
 * Facebook "Download your information" defaults to HTML. Each friend is a box with their name
 * followed by the date you became friends (current layout: class "_a6-g"; older: "uiBoxWhite";
 * oldest: a <li>Name (date)</li> list).
 */
export function parseFacebookFriendsHtml(html: string): Candidate[] {
  const body = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  const textsOf = (chunk: string) =>
    chunk
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map((t) => decodeEntities(t).trim())
      .filter(Boolean);
  const found: { name: string; date?: string }[] = [];
  const blocks = body.split(/<div class="[^"]*\b(?:_a6-g|uiBoxWhite)\b[^"]*">/).slice(1);
  for (const b of blocks) {
    const [name, ...rest] = textsOf(b);
    if (!name || FB_DATE.test(name)) continue;
    found.push({ name, date: rest.map(fbDate).find(Boolean) });
  }
  if (!found.length) {
    for (const m of body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const t = textsOf(m[1]).join(' ');
      const mm = /^(.+?)\s*\((.+)\)\s*$/.exec(t);
      const name = (mm ? mm[1] : t).trim();
      if (name) found.push({ name, date: mm ? fbDate(mm[2]) : undefined });
    }
  }
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const { name, date } of found) {
    const n = fixMojibake(name).trim();
    // Skip page furniture like the "Your friends" heading.
    if (!n || n.length > 80 || /^(your |friends?$)/i.test(n) || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push({ source: 'facebook', externalId: n.toLowerCase(), name: n, connectedOn: date });
  }
  return out;
}

/* ---------------- address books (contacts you uploaded to Facebook / Instagram) ---------------- */

/**
 * Facebook's your_address_books.json and Instagram's synced_contacts.json are copies of your
 * phone's contacts that you once let the app upload: names with phone numbers and emails.
 * They're treated like phone contacts. Returns null if this isn't an address book.
 */
export function parseAddressBook(json: unknown): Candidate[] | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const top = Object.entries(json as Record<string, unknown>);
  // Instagram: { contacts_contact_info: [{ string_map_data: { "First Name": {value}, ... } }] }
  const ig = top.find(([k, v]) => /contact/i.test(k) && Array.isArray(v) && (v as any[])[0]?.string_map_data);
  if (ig) {
    const key = nameKeys();
    const out: Candidate[] = [];
    for (const item of ig[1] as { string_map_data?: Record<string, { value?: string }> }[]) {
      const m = item.string_map_data ?? {};
      const get = (label: string) => fixMojibake(Object.entries(m).find(([k]) => k.toLowerCase() === label)?.[1]?.value?.trim() ?? '');
      const name = [get('first name'), get('last name')].filter(Boolean).join(' ');
      const info = get('contact information');
      const display = name || info;
      if (!display) continue;
      const emails = info.includes('@') ? [info] : undefined;
      const phones = info && !info.includes('@') ? [info] : undefined;
      out.push({ source: 'phone', externalId: 'ig-contacts:' + key(display + ' ' + info), name: display, phones, emails, quiet: true });
    }
    return out;
  }
  // Facebook: { address_book_v2: { address_book: [{ name, details: [{ contact_point }] }] } } (shapes vary by year)
  const fbList = (() => {
    for (const [k, v] of top) {
      if (!/address_book/i.test(k)) continue;
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') for (const inner of Object.values(v)) if (Array.isArray(inner)) return inner;
    }
    return null;
  })();
  if (!fbList) return null;
  const key = nameKeys();
  const out: Candidate[] = [];
  for (const item of fbList as { name?: string; details?: { contact_point?: string }[]; created_timestamp?: number }[]) {
    const name = fixMojibake(item?.name ?? '').trim();
    const points = (item?.details ?? []).map((d) => d.contact_point?.trim()).filter((x): x is string => !!x);
    const display = name || points[0];
    if (!display) continue;
    const emails = points.filter((p) => p.includes('@'));
    const phones = points.filter((p) => !p.includes('@'));
    out.push({
      source: 'phone',
      externalId: 'fb-contacts:' + key(display + ' ' + (points[0] ?? '')),
      name: display,
      phones: phones.length ? phones : undefined,
      emails: emails.length ? emails : undefined,
      quiet: true,
      // When the contact was saved in your phone (Facebook records it).
      ...(item.created_timestamp ? { connectedOn: isoFromTimestamp(item.created_timestamp) } : {}),
    });
  }
  return out;
}
