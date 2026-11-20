/**
 * The CRM database as one file (`crm.sqlite`) in a private GitHub repository of your own.
 * Every upload is a commit, so the repo's history is a full backup: any older version can be
 * restored from GitHub.
 *
 * Uses a fine-grained personal access token with "Contents: Read and write" on that one repo.
 */

const API = 'https://api.github.com';
export const DATA_PATH = 'crm.sqlite';

export interface GhRepo {
  owner: string;
  repo: string;
  branch: string;
}

export interface GhFile {
  /** Git blob SHA: changes every time the file changes. */
  sha: string;
  size: number;
}

export class GitHubAuthError extends Error {}
/** Another device committed first. Sync again to pick up its version. */
export class GitHubConflictError extends Error {}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
  });
  if (res.ok || res.status === 404) return res;
  const body = await res.json().catch(() => ({}));
  const msg: string = body?.message ?? res.statusText;
  if (res.status === 401) throw new GitHubAuthError('GitHub token is invalid or expired. Paste a new one in Import & settings.');
  if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub rate limit reached. Sync will retry shortly.');
  if (res.status === 403) throw new GitHubAuthError('This GitHub token can’t write to the data repo. Give it “Contents: Read and write” on that repo.');
  if (res.status === 409 || res.status === 422) throw new GitHubConflictError('Another device saved at the same moment.');
  throw new Error(`GitHub: ${msg}`);
}

const contents = (r: GhRepo) => `${API}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/contents/${DATA_PATH}`;

/** Check the repo exists, is private, and find its default branch. */
export async function checkRepo(token: string, owner: string, repo: string): Promise<GhRepo> {
  const res = await call(token, `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (res.status === 404) throw new Error(`Can’t find ${owner}/${repo}. Create it first (private), and give the token access to it.`);
  const info = (await res.json()) as { private: boolean; default_branch: string; permissions?: { push?: boolean } };
  if (!info.private) throw new Error(`${owner}/${repo} is public. Your contacts would be visible to everyone. Make it private first.`);
  if (info.permissions && info.permissions.push === false) throw new GitHubAuthError('This token can read the repo but not write to it.');
  return { owner, repo, branch: info.default_branch || 'main' };
}

export async function findFile(token: string, r: GhRepo): Promise<GhFile | null> {
  const res = await call(token, `${contents(r)}?ref=${encodeURIComponent(r.branch)}&t=${Date.now()}`, {
    headers: { Accept: 'application/vnd.github.object+json' },
  });
  if (res.status === 404) return null;
  const f = (await res.json()) as { sha: string; size: number; type: string };
  return f.type === 'file' ? { sha: f.sha, size: f.size } : null;
}

export async function download(token: string, r: GhRepo): Promise<Uint8Array> {
  const res = await call(token, `${contents(r)}?ref=${encodeURIComponent(r.branch)}&t=${Date.now()}`, {
    headers: { Accept: 'application/vnd.github.raw' },
  });
  if (res.status === 404) throw new Error('The data file disappeared from GitHub.');
  return new Uint8Array(await res.arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Commit the database. `sha` is the version being replaced (omit for the first upload). Returns the new version. */
export async function upload(token: string, r: GhRepo, bytes: Uint8Array, message: string, sha?: string): Promise<GhFile> {
  const res = await call(token, contents(r), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64(bytes), branch: r.branch, ...(sha ? { sha } : {}) }),
  });
  if (res.status === 404) throw new Error('GitHub refused the upload. Check the token has access to the data repo.');
  const out = (await res.json()) as { content: { sha: string; size: number } };
  return { sha: out.content.sha, size: out.content.size };
}
