/**
 * Where to open someone's profile for each place they came from, when the export gave us enough
 * to build a link. Facebook's friends export has names only, so it never links.
 */
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
  for (const r of rows) {
    if (out[r.source]) continue;
    out[r.source] = profileUrl(r.source, r.external_id, r.handle, phone) ?? out[r.source] ?? null;
  }
  return out;
}
