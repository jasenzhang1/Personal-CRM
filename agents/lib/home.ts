/**
 * Everything the agents keep on this computer lives in ~/.personal-crm, never in this repo (the
 * repo is public). Secrets are encrypted with Windows DPAPI by agents/setup.ps1, so only your
 * Windows account on this computer can read them. Env vars work too (for other systems):
 * CRM_DATA_REPO, CRM_GITHUB_TOKEN, LINKEDIN_PASSWORD.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const HOME = process.env.CRM_AGENT_HOME ?? path.join(homedir(), '.personal-crm');

export const dir = (...parts: string[]) => {
  const p = path.join(HOME, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

export interface AgentConfig {
  /** "owner/repo" of the private data repo. */
  dataRepo?: string;
  /** Installed browser to drive: "msedge" (default, always on Windows) or "chrome". */
  browserChannel?: string;
  /** Run the browser without a window. LinkedIn is more likely to challenge headless browsers. */
  headless?: boolean;
  /** Ask LinkedIn for a fresh archive at most this often (days). */
  requestEveryDays?: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export const loadConfig = (): AgentConfig => readJson(path.join(HOME, 'config.json'), {});

export function loadState<T extends object>(name: string): Partial<T> {
  return readJson<Partial<T>>(path.join(dir('state'), `${name}.json`), {});
}

export function saveState<T extends object>(name: string, state: T) {
  writeFileSync(path.join(dir('state'), `${name}.json`), JSON.stringify(state, null, 2));
}

/** Decrypt a value saved by setup.ps1 (ConvertFrom-SecureString = DPAPI, current user only). */
function dpapiDecrypt(blob: string): string {
  const script =
    '$s = ConvertTo-SecureString $env:CRM_SECRET_BLOB; ' +
    '[Console]::Out.Write([System.Net.NetworkCredential]::new("", $s).Password)';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CRM_SECRET_BLOB: blob },
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function secret(name: 'githubToken' | 'linkedinPassword'): string | undefined {
  const env = { githubToken: 'CRM_GITHUB_TOKEN', linkedinPassword: 'LINKEDIN_PASSWORD' }[name];
  if (process.env[env]) return process.env[env];
  const blob = readJson<Record<string, string>>(path.join(HOME, 'secrets.json'), {})[name];
  if (!blob) return undefined;
  try {
    return dpapiDecrypt(blob) || undefined;
  } catch {
    throw new Error(`Couldn't decrypt ${name} from ${path.join(HOME, 'secrets.json')}. Run agents/setup.ps1 again.`);
  }
}

export function logger(name: string) {
  const file = path.join(dir('logs'), `${name}.log`);
  return (msg: string) => {
    const line = `${new Date().toISOString()}  ${msg}`;
    console.log(line);
    appendFileSync(file, line + '\n');
  };
}

/** Best-effort Windows notification, so a run that needs you doesn't fail silently. */
export function notify(title: string, body: string) {
  if (process.platform !== 'win32' || process.env.CRM_AGENT_QUIET) return;
  const script = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $n = $t.GetElementsByTagName('text')
    $n.Item(0).AppendChild($t.CreateTextNode($env:CRM_TOAST_TITLE)) > $null
    $n.Item(1).AppendChild($t.CreateTextNode($env:CRM_TOAST_BODY)) > $null
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CRM_TOAST_TITLE: title, CRM_TOAST_BODY: body },
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Notifications are a nicety; the log has the details.
  }
}

export const exists = existsSync;
