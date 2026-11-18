/**
 * "Grab picture" bookmark for the photo round.
 *
 * You click it yourself while looking at someone's Instagram or LinkedIn profile, in your own
 * signed-in browser. It reads the profile picture that's already on screen and sends it to the
 * Personal CRM tab that opened the profile; that tab saves it and answers with the next profile,
 * which the bookmark then opens. No bot, no password: every page view is your own click.
 */

/** Sites the bookmark may send pictures from. */
export const GRAB_ORIGINS = ['https://www.instagram.com', 'https://instagram.com', 'https://www.linkedin.com', 'https://linkedin.com'];

export interface GrabMessage {
  type: 'crm-photo';
  page: string; // the profile URL the picture came from
  src: string | null; // picture URL (null = they have no picture)
  data: string | null; // the picture itself as a data: URL, when the site allowed reading it
}

// Runs on instagram.com / linkedin.com. Plain JS, no dependencies, kept small enough for a bookmark.
const SOURCE = `(async () => {
  const crm = window.opener;
  if (!crm) { alert('Open this profile from the Photo round in Personal CRM first (so it can receive the picture), then click this bookmark.'); return; }
  const square = (i) => { const r = i.getBoundingClientRect(); return r.width >= 64 && r.top < 750 && Math.abs(r.width - r.height) < 10; };
  const imgs = [...document.images].filter((i) => (i.currentSrc || i.src) && !(i.currentSrc || i.src).startsWith('data:'));
  const biggest = imgs.filter(square).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const ig = location.hostname.includes('instagram');
  const pick = ig
    ? imgs.find((i) => /profile (picture|photo)/i.test(i.alt) && square(i)) || biggest
    : document.querySelector('img.pv-top-card-profile-picture__image--show, img.pv-top-card-profile-picture__image, .pv-top-card__photo img, img.profile-photo-edit__preview') || biggest;
  const src = pick ? pick.currentSrc || pick.src : null;
  /* Default "no photo" silhouettes don't count. */
  const none = !src || /44884218_345707102882519|ghost|static\\.licdn\\.com|default[-_]?(avatar|profile)/i.test(src);
  let data = null;
  if (!none) {
    try {
      const blob = await (await fetch(src, { credentials: 'omit' })).blob();
      if (blob.type.startsWith('image/')) data = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(blob); });
    } catch (e) {}
  }
  const reply = new Promise((ok) => {
    const on = (e) => { if (e.source === crm && e.data && e.data.type === 'crm-next') { removeEventListener('message', on); ok(e.data); } };
    addEventListener('message', on);
    setTimeout(() => ok(null), 5000);
  });
  crm.postMessage({ type: 'crm-photo', page: location.href, src: none ? null : src, data }, '*');
  const r = await reply;
  if (!r) { alert('Personal CRM didn\\u2019t answer. Is the Photo round still open in the other tab?'); return; }
  if (r.url) location.href = r.url; else alert(r.message || 'Saved!');
})();`;

/** The bookmark's address: drag it to the bookmarks bar. */
export const grabberBookmarklet = () => 'javascript:' + encodeURIComponent(SOURCE.replace(/\n\s*/g, ' '));

/** Is this message really a picture from the bookmark on Instagram/LinkedIn? */
export function isGrabMessage(e: MessageEvent): e is MessageEvent<GrabMessage> {
  const d = e.data as Partial<GrabMessage> | null;
  if (!GRAB_ORIGINS.includes(e.origin) || !d || d.type !== 'crm-photo' || typeof d.page !== 'string') return false;
  if (d.data != null && !(typeof d.data === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(d.data))) return false;
  if (d.src != null && !(typeof d.src === 'string' && d.src.startsWith('https://'))) return false;
  return true;
}

/** "https://www.instagram.com/jane.doe/" → { source: 'instagram', id: 'jane.doe' } */
export function profileKey(url: string): { source: 'instagram' | 'linkedin'; id: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (/instagram\.com$/.test(u.hostname) && parts[0]) return { source: 'instagram', id: parts[0].toLowerCase() };
    if (/linkedin\.com$/.test(u.hostname) && parts[0] === 'in' && parts[1]) return { source: 'linkedin', id: decodeURIComponent(parts[1]).toLowerCase() };
  } catch {
    /* not a URL */
  }
  return null;
}
