/**
 * Gravatar: a free, public profile-picture service tied to an email address (used by WordPress,
 * GitHub, Slack and others). We only send a scrambled (SHA-256) version of the email, never the
 * email itself, and only keep a picture if the person has actually set one.
 */
export async function gravatarUrl(email: string, size = 160): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // d=404: no default picture, so "no Gravatar" fails to load instead of showing a placeholder.
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/** Does this picture load? (Works without the site allowing cross-site reads.) */
export function imageExists(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      resolve(false);
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth > 0);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = url;
  });
}

/** Run `fn` over items, a few at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
