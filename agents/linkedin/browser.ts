/**
 * Drives LinkedIn's own "Get a copy of your data" page in a real browser (Edge by default) with a
 * profile you signed into yourself (`npm run linkedin -- --login`). It only ever visits that one
 * settings page: it downloads an archive when one is ready, and asks for a new one when it's due.
 * It never opens anyone's profile or reads other pages.
 *
 * Automating LinkedIn is against its User Agreement and can get an account restricted. You chose
 * that trade-off; this keeps the footprint as small as possible (one page, a few clicks, human
 * pauses, at most one request per day).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core';
import { dir } from '../lib/home.ts';

export const EXPORT_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data';
const LOGIN_URL = 'https://www.linkedin.com/login';
const SIGNED_OUT = /linkedin\.com\/(login|authwall|uas\/login|checkpoint|signup)/i;

export interface BrowserOpts {
  channel: string;
  headless: boolean;
}

const pause = (min = 800, max = 2200) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function open(opts: BrowserOpts): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir('linkedin', 'browser-profile'), {
    channel: opts.channel,
    headless: opts.headless,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: opts.headless ? [] : ['--start-minimized'],
  });
}

/** Open a window on LinkedIn's sign-in page and wait for you to sign in (or close it). */
export async function login(opts: BrowserOpts): Promise<boolean> {
  const ctx = await chromium.launchPersistentContext(dir('linkedin', 'browser-profile'), { channel: opts.channel, headless: false, viewport: null });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(LOGIN_URL);
  try {
    await page.waitForURL((u) => /linkedin\.com\/(feed|in\/|mynetwork|mypreferences)/.test(u.href), { timeout: 10 * 60_000 });
    await page.goto(EXPORT_URL);
    await pause(2000, 3000);
    return true;
  } catch {
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** LinkedIn's settings pages sometimes render inside an iframe, so look in every frame. */
async function find(page: Page, make: (f: Frame) => Locator): Promise<Locator | null> {
  for (const f of page.frames()) {
    const l = make(f);
    if (await l.count().catch(() => 0)) return l;
  }
  return null;
}

async function pageText(page: Page): Promise<string> {
  const parts = await Promise.all(page.frames().map((f) => f.locator('body').innerText().catch(() => '')));
  return parts.join('\n');
}

export interface PageState {
  signedOut: boolean;
  downloadable: boolean;
  pending: boolean;
  requestable: boolean;
}

const PENDING = /(preparing your|being prepared|will be ready|we.re (working on|getting)|request is in progress|check back)/i;

export async function readState(page: Page): Promise<PageState> {
  if (SIGNED_OUT.test(page.url())) return { signedOut: true, downloadable: false, pending: false, requestable: false };
  const text = await pageText(page);
  const download = await find(page, (f) => f.getByRole('button', { name: /download archive/i }).or(f.getByRole('link', { name: /download archive/i })));
  const request = await find(page, (f) => f.getByRole('button', { name: /request archive/i }));
  return {
    signedOut: false,
    downloadable: !!download,
    pending: PENDING.test(text),
    requestable: !!request && (await request.first().isEnabled().catch(() => false)),
  };
}

/** Save a screenshot and the page's HTML, for when LinkedIn changes the page. */
export async function capture(page: Page, why: string): Promise<string> {
  const base = path.join(dir('linkedin', 'debug'), new Date().toISOString().replace(/[:.]/g, '-'));
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const html = (await Promise.all(page.frames().map((f) => f.content().catch(() => '')))).join('\n<!-- frame -->\n');
  writeFileSync(`${base}.html`, `<!-- ${why} | ${page.url()} -->\n${html}`);
  return `${base}.png`;
}

export interface Downloaded {
  file: string;
  sha256: string;
}

async function downloadAll(page: Page, log: (m: string) => void): Promise<Downloaded[]> {
  const out: Downloaded[] = [];
  const buttons = await find(page, (f) => f.getByRole('button', { name: /download archive/i }).or(f.getByRole('link', { name: /download archive/i })));
  if (!buttons) return out;
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    await pause();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), buttons.nth(i).click()]);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = path.join(dir('linkedin', 'archives'), `linkedin-${stamp}-${i + 1}-${dl.suggestedFilename()}`.replace(/[^\w.\-]+/g, '_'));
    await dl.saveAs(file);
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    log(`Downloaded ${path.basename(file)}`);
    out.push({ file, sha256 });
  }
  return out;
}

async function requestArchive(page: Page, password: string, log: (m: string) => void): Promise<boolean> {
  // "Download larger data archive" is the option that reliably includes Connections.
  const larger = await find(page, (f) => f.getByLabel(/larger data archive/i).or(f.getByText(/download larger data archive/i)));
  if (larger) {
    await pause();
    await larger.first().click();
  }
  const request = await find(page, (f) => f.getByRole('button', { name: /request archive/i }));
  if (!request) return false;
  await pause();
  await request.first().click();
  await pause(1500, 3000);
  const pw = await find(page, (f) => f.locator('input[type="password"]'));
  if (pw) {
    await pw.first().fill(password);
    await pause();
    const done = await find(page, (f) => f.getByRole('button', { name: /^(done|submit|verify|continue|confirm)$/i }));
    if (done) await done.first().click();
    else await pw.first().press('Enter');
  }
  await pause(4000, 6000);
  const after = await readState(page);
  if (after.pending) log('Requested a new archive. LinkedIn emails you when it is ready (the first part usually within minutes, all of it within a day).');
  return after.pending;
}

export interface RunResult {
  status: 'ok' | 'needs-login' | 'unrecognized';
  downloads: Downloaded[];
  requested: boolean;
  state?: PageState;
  debug?: string;
}

/**
 * One visit to the export page: download what's ready, then ask for a fresh archive if
 * `wantRequest(state)` says it's due.
 */
export async function visitExportPage(
  opts: BrowserOpts,
  password: string | undefined,
  wantRequest: (s: PageState) => boolean,
  log: (m: string) => void,
): Promise<RunResult> {
  const ctx = await open(opts);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(EXPORT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await pause(2000, 4000);
    let state = await readState(page);
    if (state.signedOut) return { status: 'needs-login', downloads: [], requested: false, state };
    if (!state.downloadable && !state.pending && !state.requestable) {
      return { status: 'unrecognized', downloads: [], requested: false, state, debug: await capture(page, 'no download, pending or request control found') };
    }
    const downloads = state.downloadable ? await downloadAll(page, log) : [];
    if (downloads.length) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await pause(2000, 4000);
      state = await readState(page);
    }
    let requested = false;
    if (wantRequest(state)) {
      if (!password) log('A new archive is due, but no LinkedIn password is saved, so it can’t be requested. Run agents/setup.ps1 to add it.');
      else {
        requested = await requestArchive(page, password, log);
        if (!requested) return { status: 'unrecognized', downloads, requested, state, debug: await capture(page, 'request did not go through') };
      }
    }
    return { status: 'ok', downloads, requested, state };
  } finally {
    await ctx.close().catch(() => {});
  }
}
