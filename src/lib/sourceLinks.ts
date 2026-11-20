/**
 * Where to open someone's profile for each place they came from, when the export gave us enough
 * to build a link. Facebook's friends export has names only (no profile link or id), so Facebook
 * opens a search for their name until facebook_friend_links.json (lib/fbFriendLinks) gives their
 * real profile link, kept as the handle.
 */
const isFacebookUrl = (h: string) => /^https:\/\/www\.facebook\.com\//.test(h);

export function profileUrl(source: string, externalId: string, handle: string | null, phone?: string | null): string | null {
  if (externalId.startsWith('chat:')) return null; // a chat, not an account
  const h = handle?.trim() ?? '';
  switch (source) {
    case 'instagram': {
      const u = (h || externalId).replace(/^@/, '');
      return /^[A-Za-z0-9._]{1,30}$/.test(u) ? `https://www.instagram.com/${u}/` : null;
    }
    case 'linkedin':
      return /^https?:\/\/(www\.)?linkedin\.com\//i.test(h) ? h : /^https?:\/\/(www\.)?linkedin\.com\//i.test(externalId) ? externalId : null;
    case 'facebook':
      if (isFacebookUrl(h)) return h;
      return externalId.startsWith('fb-contacts:') ? null : `https://www.facebook.com/search/people/?q=${encodeURIComponent(externalId)}`;
    case 'discord':
      return /^\d{5,}$/.test(externalId) ? `https://discord.com/users/${externalId}` : null;
    case 'google': {
      // Saved Google Contacts open in Google Contacts; people you've only emailed don't have a page.
      const m = /^people\/(c\d+)$/.exec(externalId);
      return m ? `https://contacts.google.com/person/${m[1]}` : null;
    }
    case 'phone':
      return phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null;
    default:
      return null;
  }
}

/** One link per source (the first one that has a link), for a person's source rows. */
export function sourceLinks(rows: { source: string; external_id: string; handle: string | null }[], phone?: string | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  // A real Facebook profile link beats a name search, whichever row it's on.
  const ordered = [...rows].sort((a, b) => Number(isFacebookUrl(b.handle ?? '')) - Number(isFacebookUrl(a.handle ?? '')));
  for (const r of ordered) {
    if (out[r.source]) continue;
    out[r.source] = profileUrl(r.source, r.external_id, r.handle, phone) ?? out[r.source] ?? null;
  }
  return out;
}

/**
 * The same profile as a link that opens the platform's own app, for phones. Android gets an
 * intent:// link that falls back to the website by itself if the app isn't installed; iOS gets
 * the app's URL scheme (the caller falls back to the website if nothing opens). Null when the
 * website link is the best we can do.
 */
export function appProfileUrl(source: string, href: string, os: 'ios' | 'android'): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (os === 'android') {
    const pkg = ({ instagram: 'com.instagram.android', linkedin: 'com.linkedin.android', facebook: 'com.facebook.katana' } as Record<string, string>)[source];
    if (!pkg) return null;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(href)};end`;
  }
  switch (source) {
    case 'instagram': {
      const m = /^\/([A-Za-z0-9._]{1,30})$/.exec(path);
      return m ? `instagram://user?username=${m[1]}` : null;
    }
    case 'linkedin': {
      const m = /^\/(in|company|school)\/([^/]+)$/.exec(path);
      return m ? `linkedin://${m[1]}/${m[2]}` : null;
    }
    case 'facebook':
      // A name search opens fine on the website; real profiles open in the app.
      return path.startsWith('/search') ? null : `fb://facewebmodal/f?href=${encodeURIComponent(href)}`;
    default:
      return null;
  }
}
