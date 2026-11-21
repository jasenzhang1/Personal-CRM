/**
 * Edit the CRM database in the private GitHub data repo from Node, the same way another device
 * would: download crm.sqlite, change it with the app's own code, commit it back. Every commit is a
 * version in the repo's history, so a bad run can always be undone there.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SQLiteDatabase, SqlParam } from '../../src/db/types.ts';
import { migrate } from '../../src/db/schema.ts';
import { checkRepo, download, findFile, GitHubConflictError, upload } from '../../src/sync/github.ts';

/** The app's async SQLite surface, backed by Node's built-in SQLite. */
export function nodeDb(d: DatabaseSync): SQLiteDatabase {
  const args = (p: (SqlParam | SqlParam[])[]) => (p.length === 1 && Array.isArray(p[0]) ? p[0] : p) as SqlParam[];
  return {
    execAsync: async (sql) => void d.exec(sql),
    runAsync: async (sql, ...p) => {
      const r = d.prepare(sql).run(...args(p));
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getFirstAsync: async <T>(sql: string, ...p: (SqlParam | SqlParam[])[]) => (d.prepare(sql).get(...args(p)) as T) ?? null,
    getAllAsync: async <T>(sql: string, ...p: (SqlParam | SqlParam[])[]) => d.prepare(sql).all(...args(p)) as T[],
    withTransactionAsync: async (fn) => {
      d.exec('BEGIN');
      try {
        await fn();
        d.exec('COMMIT');
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** What a change did. Nothing is committed unless `changed`. */
export interface Edit {
  changed: boolean;
  summary: string;
}

/** Run `fn` on a copy of the database file and return the new file's bytes. */
export async function editBytes(bytes: Uint8Array | null, fn: (db: SQLiteDatabase) => Promise<Edit>): Promise<{ edit: Edit; bytes: Uint8Array }> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crm-agent-'));
  const file = path.join(tmp, 'crm.sqlite');
  try {
    if (bytes) writeFileSync(file, bytes);
    const d = new DatabaseSync(file);
    let edit: Edit;
    try {
      d.exec('PRAGMA journal_mode = DELETE');
      const db = nodeDb(d);
      await migrate(db);
      edit = await fn(db);
    } finally {
      d.close();
    }
    return { edit, bytes: new Uint8Array(readFileSync(file)) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Download, edit, commit. If a device commits in between, start over from its version, so the
 * agent never overwrites someone's edits.
 */
export async function editDataRepo(
  token: string,
  repoFull: string,
  who: string,
  fn: (db: SQLiteDatabase) => Promise<Edit>,
  opts: { dryRun?: boolean } = {},
): Promise<Edit> {
  const [owner, name] = repoFull.split('/');
  if (!owner || !name) throw new Error(`Data repo should look like owner/name, not "${repoFull}".`);
  const repo = await checkRepo(token, owner, name);
  for (let attempt = 1; ; attempt++) {
    const remote = await findFile(token, repo);
    if (!remote) throw new Error(`${repoFull} has no ${'crm.sqlite'} yet. Connect the app to it first (Import & settings → GitHub sync).`);
    const { edit, bytes } = await editBytes(await download(token, repo), fn);
    if (!edit.changed || opts.dryRun) return edit;
    try {
      await upload(token, repo, bytes, `Update CRM from ${who}: ${edit.summary}`, remote?.sha);
      return edit;
    } catch (e) {
      if (e instanceof GitHubConflictError && attempt < 3) continue;
      throw e;
    }
  }
}
