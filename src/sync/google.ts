import { fromGooglePeople, type Candidate, type GooglePerson } from './parsers';

/**
 * Live sync with Google Contacts + Gmail "other contacts" (people you've emailed).
 * Runs entirely in the browser: Google Identity Services gives a short-lived read-only token,
 * then we call the People API. Requires a free OAuth Client ID (see the Import page).
 */

const SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
].join(' ');

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string; error_description?: string };
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
export function getToken(clientId: string, scope = SCOPES): Promise<{ token: string; expiresIn: number }> {
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (r) =>
        r.access_token ? resolve({ token: r.access_token, expiresIn: Number(r.expires_in) || 3600 }) : reject(new Error(r.error_description || r.error || 'Google sign-in failed')),
      error_callback: (e) =>
        reject(new Error(e.type === 'popup_closed' ? 'Google sign-in window was closed.' : e.message || 'Google sign-in failed (popup blocked?).')),
    });
    client.requestAccessToken({ prompt: '' });
  });
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

export async function fetchGoogleContacts(clientId: string): Promise<Candidate[]> {
  await loadGis();
  const { token } = await getToken(clientId.trim());
  const [saved, other] = await Promise.all([
    fetchAll(
      'https://people.googleapis.com/v1/people/me/connections?pageSize=1000&personFields=names,emailAddresses,phoneNumbers,birthdays,organizations,photos,addresses',
      'connections',
      token,
    ),
    fetchAll('https://people.googleapis.com/v1/otherContacts?pageSize=1000&readMask=names,emailAddresses,phoneNumbers', 'otherContacts', token),
  ]);
  return fromGooglePeople([...saved, ...other]);
}
