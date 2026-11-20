import { fromGooglePeople, type Candidate, type GooglePerson } from './parsers';

/**
 * Live sync with Google Contacts + Gmail "other contacts" (people you've emailed).
 * Runs entirely in the browser: Google Identity Services gives a short-lived read-only token,
 * then we call the People API. Requires a free OAuth Client ID (see the Import page).
 */

export const CONTACT_SCOPES = ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts.other.readonly'];
const SCOPES = CONTACT_SCOPES.join(' ');

type TokenResponse = { access_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;
export function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Couldn't reach Google. Check your internet connection."));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

/** A short-lived (about 1 hour) access token. Opens Google's sign-in popup, so call it from a tap or click. */
export function getToken(clientId: string, scope = SCOPES): Promise<{ token: string; expiresIn: number; scopes: string[] }> {
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (r) =>
        r.access_token
          ? resolve({ token: r.access_token, expiresIn: Number(r.expires_in) || 3600, scopes: (r.scope ?? scope).split(/\s+/).filter(Boolean) })
          : reject(new Error(r.error_description || r.error || 'Google sign-in failed')),
      error_callback: (e) =>
        reject(new Error(e.type === 'popup_closed' ? 'Google sign-in window was closed.' : e.message || 'Google sign-in failed (popup blocked?).')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/*
 * One Google sign-in shared by Drive sync and the daily contacts check, so a single tap covers both.
 * Every sign-in asks for all the scopes the features you've turned on need; the token (about an
 * hour) is kept in localStorage so reopening the app within the hour needs no tap.
 */

const TOKEN_KEY = 'crm.gtoken';
const wanted = new Map<string, string[]>();

/** Features say which scopes they need while they're on, so any sign-in asks for all of them. */
export function wantScopes(feature: string, scopes: string[] | null) {
  if (scopes) wanted.set(feature, scopes);
  else wanted.delete(feature);
}

/** A saved token that's still good for another minute and covers these scopes. */
export function cachedToken(needs: string[]): string | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as { token: string; exp: number; scopes: string[] } | null;
    if (!t || t.exp < Date.now() + 60_000) return null;
    return needs.every((s) => t.scopes.includes(s)) ? t.token : null;
  } catch {
    return null;
  }
}

/** Sign in for these scopes plus everything else that's turned on. Call from a tap: it opens Google's popup. */
export async function signIn(clientId: string, needs: string[]): Promise<string> {
  await loadGis();
  const scopes = [...new Set([...needs, ...[...wanted.values()].flat()])];
  const { token, expiresIn, scopes: granted } = await getToken(clientId.trim(), scopes.join(' '));
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + expiresIn * 1000, scopes: granted }));
  } catch {
    /* storage blocked: the token still works for this call */
  }
  return token;
}

export function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing saved */
  }
}

async function fetchAll(url: string, key: 'connections' | 'otherContacts', token: string): Promise<GooglePerson[]> {
  const out: GooglePerson[] = [];
  let pageToken = '';
  do {
    const res = await fetch(`${url}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg: string = body?.error?.message ?? res.statusText;
      if (/has not been used|is disabled/i.test(msg)) throw new Error('Turn on the "People API" in your Google Cloud project (step 2 of the setup), wait a minute, then try again.');
      throw new Error(`Google: ${msg}`);
    }
    const body = await res.json();
    out.push(...((body[key] as GooglePerson[] | undefined) ?? []));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const SAVED_URL =
  'https://people.googleapis.com/v1/people/me/connections?pageSize=1000&personFields=names,emailAddresses,phoneNumbers,birthdays,organizations,photos,addresses';

/** Saved contacts and everyone you've emailed. Opens Google's sign-in unless a recent one covers it. */
export async function fetchGoogleContacts(clientId: string): Promise<Candidate[]> {
  const token = cachedToken(CONTACT_SCOPES) ?? (await signIn(clientId, CONTACT_SCOPES));
  const [saved, other] = await Promise.all([
    fetchAll(SAVED_URL, 'connections', token),
    fetchAll('https://people.googleapis.com/v1/otherContacts?pageSize=1000&readMask=names,emailAddresses,phoneNumbers', 'otherContacts', token),
  ]);
  return fromGooglePeople([...saved, ...other]);
}

export class GoogleAuthError extends Error {}

/**
 * Just your saved contacts (the ones on your phone, when it saves to Gmail). Used by the daily
 * check, so people you merely emailed don't fill the Inbox every day.
 */
export async function fetchSavedContacts(token: string): Promise<Candidate[]> {
  try {
    return fromGooglePeople(await fetchAll(SAVED_URL, 'connections', token));
  } catch (e) {
    if (e instanceof Error && /UNAUTHENTICATED|invalid authentication|insufficient|PERMISSION_DENIED/i.test(e.message)) {
      forgetToken();
      throw new GoogleAuthError('Google sign-in expired.');
    }
    throw e;
  }
}
