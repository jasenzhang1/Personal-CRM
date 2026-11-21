/**
 * The daily LinkedIn agent.
 *
 *   npm run linkedin                     one daily run: download a ready archive, import it, request the next
 *   npm run linkedin -- --login          sign in to LinkedIn in the agent's browser (once, and whenever it asks)
 *   npm run linkedin -- --import a.zip   import an archive you downloaded yourself
 *   npm run linkedin -- --status         what the last runs did
 *   add --headed to watch the browser, --dry-run to import without committing
 *
 * Windows Task Scheduler runs it every day (agents/setup.ps1 sets that up).
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dir, HOME, loadConfig, loadState, logger, notify, saveState, secret } from '../lib/home.ts';
import { editDataRepo } from '../lib/dataRepo.ts';
import { importLinkedInZip } from './importArchive.ts';
import { login, visitExportPage, type BrowserOpts } from './browser.ts';
import { isNew, requestDue, type LinkedInState } from './schedule.ts';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const log = logger('linkedin');
const config = loadConfig();
const state = loadState<LinkedInState>('linkedin');
const browser: BrowserOpts = { channel: config.browserChannel ?? 'msedge', headless: flag('--headed') ? false : (config.headless ?? false) };
const KEEP_ARCHIVES = 3;

function finish(status: string, message: string, code: number): never {
  saveState('linkedin', { ...state, lastRunAt: new Date().toISOString(), lastStatus: status, lastMessage: message });
  log(`${status}: ${message}`);
  process.exit(code);
}

function needDataRepo(): { token: string; repo: string } {
  const repo = process.env.CRM_DATA_REPO ?? config.dataRepo;
  const token = secret('githubToken');
  if (!repo || !token) finish('setup-needed', `No data repo or GitHub token saved. Run agents/setup.ps1 (it saves them in ${HOME}).`, 4);
  return { repo, token };
}

async function importZip(file: string, sha256: string): Promise<void> {
  const { repo, token } = needDataRepo();
  const edit = await editDataRepo(token, repo, 'LinkedIn agent', (db) => importLinkedInZip(db, new Uint8Array(readFileSync(file)), path.basename(file)), { dryRun: flag('--dry-run') });
  log(`${flag('--dry-run') ? '(dry run, not committed) ' : ''}${edit.summary}`);
  if (!flag('--dry-run')) {
    state.imported = [...(state.imported ?? []), sha256].slice(-50);
    state.lastImportAt = new Date().toISOString();
  }
}

/** Archives hold your connections' emails: keep only the last few on disk. */
function pruneArchives() {
  const d = dir('linkedin', 'archives');
  const files = readdirSync(d).map((f) => path.join(d, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files.slice(KEEP_ARCHIVES)) rmSync(f, { force: true });
}

async function main() {
  if (flag('--status')) {
    console.log(JSON.stringify({ ...state, imported: `${state.imported?.length ?? 0} archives` }, null, 2));
    console.log(`Logs: ${path.join(HOME, 'logs', 'linkedin.log')}`);
    return;
  }

  if (flag('--login')) {
    console.log('Sign in to LinkedIn in the window that opens. It closes by itself once you are signed in.');
    const ok = await login(browser);
    finish(ok ? 'signed-in' : 'login-not-finished', ok ? 'Signed in. Daily runs will use this browser profile.' : 'Sign-in window closed before sign-in finished.', ok ? 0 : 1);
  }

  const manual = args[args.indexOf('--import') + 1];
  if (flag('--import')) {
    if (!manual) finish('error', 'Pass the archive: --import path/to/archive.zip', 1);
    await importZip(manual, createHash('sha256').update(readFileSync(manual)).digest('hex'));
    finish('ok', `Imported ${path.basename(manual)}.`, 0);
  }

  needDataRepo(); // fail before opening LinkedIn if the import can't happen anyway
  const everyDays = config.requestEveryDays ?? 1;
  const r = await visitExportPage(browser, secret('linkedinPassword'), (p) => requestDue(p, state, new Date(), everyDays), log);
  if (r.requested) state.lastRequestAt = new Date().toISOString();

  const problems: string[] = [];
  for (const d of r.downloads) {
    if (!isNew(d.sha256, state)) {
      log(`${path.basename(d.file)} was already imported.`);
      continue;
    }
    try {
      await importZip(d.file, d.sha256);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(msg);
      // An archive without Connections.csv will never have it; don't retry it every day.
      if (/no Connections\.csv/i.test(msg)) state.imported = [...(state.imported ?? []), d.sha256].slice(-50);
    }
  }
  pruneArchives();

  if (r.status === 'needs-login') {
    notify('Personal CRM: LinkedIn sign-in needed', 'Run "npm run linkedin -- --login" in the Personal-CRM folder.');
    finish('needs-login', 'LinkedIn signed the agent out. Run: npm run linkedin -- --login', 2);
  }
  if (r.status === 'unrecognized') {
    notify('Personal CRM: LinkedIn page changed', 'The LinkedIn agent could not find the export controls. See the debug screenshot.');
    finish('unrecognized', `Couldn't recognize LinkedIn's export page (it may have changed). Screenshot: ${r.debug}`, 3);
  }
  if (problems.length) {
    notify('Personal CRM: LinkedIn import failed', problems[0]);
    finish('error', problems.join(' | '), 1);
  }
  const what = [
    r.downloads.length ? `${r.downloads.length} archive(s) downloaded` : 'no archive ready',
    r.requested ? 'new archive requested' : r.state?.pending ? 'an archive is being prepared' : 'no request due',
  ];
  finish('ok', what.join('; ') + '.', 0);
}

main().catch((e) => {
  notify('Personal CRM: LinkedIn agent failed', e instanceof Error ? e.message : String(e));
  finish('error', e instanceof Error ? (e.stack ?? e.message) : String(e), 1);
});
