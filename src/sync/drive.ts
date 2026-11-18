/**
 * The CRM database as one file in Google Drive's hidden "app data" folder. Only this app can see
 * that folder: it doesn't show up in your Drive, and the app can't see your other files.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'crm.sqlite';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export interface DriveFile {
  id: string;
  /** Goes up every time the file changes. */
  version: string;
  modifiedTime?: string;
}

export class DriveAuthError extends Error {}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const msg: string = body?.error?.message ?? res.statusText;
  if (res.status === 401) throw new DriveAuthError('Google sign-in expired.');
  if (/has not been used|is disabled/i.test(msg))
    throw new Error('Turn on the "Google Drive API" in your Google Cloud project (see the setup steps), wait a minute, then try again.');
  if (res.status === 403 && /insufficient|scope/i.test(msg)) throw new DriveAuthError('Google Drive access wasn’t allowed. Sign in again and tick the Drive box.');
  throw new Error(`Google Drive: ${msg}`);
}

export async function findFile(token: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
  const res = await call(token, `${API}?spaces=appDataFolder&q=${q}&orderBy=modifiedTime desc&fields=files(id,version,modifiedTime)`);
  const files = ((await res.json()).files ?? []) as DriveFile[];
  return files[0] ?? null;
}

export async function download(token: string, id: string): Promise<Uint8Array> {
  const res = await call(token, `${API}/${id}?alt=media`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Create the file (no id) or replace its contents. Resumable upload, so there's no 5 MB limit. */
export async function upload(token: string, bytes: Uint8Array, id?: string): Promise<DriveFile> {
  const start = await call(token, `${UPLOAD}${id ? `/${id}` : ''}?uploadType=resumable&fields=id,version,modifiedTime`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/x-sqlite3' },
    body: JSON.stringify(id ? {} : { name: FILE_NAME, parents: ['appDataFolder'] }),
  });
  const session = start.headers.get('Location');
  if (!session) throw new Error('Google Drive didn’t accept the upload. Try again.');
  const res = await call(token, session, { method: 'PUT', headers: { 'Content-Type': 'application/x-sqlite3' }, body: bytes as BlobPart });
  return (await res.json()) as DriveFile;
}
