/**
 * "Save Facebook friend links" bookmark.
 *
 * Facebook's "Download your information" friends list has names only: no profile links. Your
 * friends page on facebook.com does show each friend's link, so this bookmark (clicked by you, in
 * your own signed-in browser, on that page) scrolls to the end of the list and downloads
 * facebook_friend_links.json. Drop that file on the Import page to give everyone their real link.
 */

import { FB_LINKS_MARK } from '@/sync/parsers';

// Runs on facebook.com. Plain JS, no dependencies.
const SOURCE = `(async () => {
  if (!/(^|\\.)facebook\\.com$/.test(location.hostname)) { alert('Open facebook.com first, then click this bookmark.'); return; }
  const path = location.pathname.replace(/\\/+$/, '');
  const onFriends = /\\/friends(_all)?$/.test(path) || /[?&]sk=friends(_all)?(&|$)/.test(location.search);
  if (!onFriends) { if (confirm('This opens your friends list. Click the bookmark again once it has loaded.')) location.href = 'https://www.facebook.com/me/friends'; return; }
  const ownId = new URLSearchParams(location.search).get('id');
  const ownUser = path.split('/')[1];
  const RESERVED = /^(friends|groups|pages|events|watch|marketplace|gaming|search|messages|notifications|settings|bookmarks|photo|photos|reel|reels|stories|story\\.php|help|policies|privacy|login|hashtag|me|profile\\.php)$/i;
  const found = new Map();
  const collect = () => {
    const root = document.querySelector('[role="main"]') || document.body;
    for (const a of root.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href); } catch (e) { continue; }
      if (!/(^|\\.)facebook\\.com$/.test(u.hostname)) continue;
      const parts = u.pathname.split('/').filter(Boolean);
      let url = null;
      if (parts.length === 1 && parts[0] === 'profile.php') {
        const id = u.searchParams.get('id');
        if (id && /^\\d+$/.test(id) && id !== ownId && !u.searchParams.get('sk')) url = 'https://www.facebook.com/profile.php?id=' + id;
      } else if (parts.length === 1 && !RESERVED.test(parts[0]) && parts[0] !== ownUser && !u.searchParams.get('sk')) {
        url = 'https://www.facebook.com/' + parts[0];
      }
      if (!url) continue;
      const name = (a.innerText || a.getAttribute('aria-label') || '').split('\\n')[0].trim();
      if (!name || name.length > 80 || /mutual friend|^\\d|^(add friend|message|follow)$/i.test(name)) { if (!found.has(url)) found.set(url, ''); continue; }
      if (!found.get(url)) found.set(url, name);
    }
  };
  const named = () => [...found.values()].filter(Boolean).length;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#1c2b33;color:#fff;font:14px system-ui,sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:280px';
  const text = document.createElement('div');
  const stop = document.createElement('button');
  stop.textContent = 'Stop and download now';
  stop.style.cssText = 'margin-top:8px;padding:4px 10px;border-radius:6px;border:0;cursor:pointer';
  let stopped = false;
  stop.onclick = () => { stopped = true; };
  box.append(text, stop);
  document.body.append(box);
  let last = -1, same = 0;
  const started = Date.now();
  while (!stopped && same < 8 && Date.now() - started < 20 * 60 * 1000) {
    collect();
    const n = named();
    text.textContent = 'Personal CRM: scrolling your friends list\\u2026 ' + n + ' friends so far. Keep this tab open.';
    same = n === last ? same + 1 : 0;
    last = n;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  collect();
  const friends = [...found].filter(([, name]) => name).map(([url, name]) => ({ name, url }));
  box.remove();
  if (!friends.length) { alert('No friends found on this page. Open your profile \\u2192 Friends (the "All friends" list) and try again.'); return; }
  const blob = new Blob([JSON.stringify({ kind: '${FB_LINKS_MARK}', saved_at: new Date().toISOString(), friends }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'facebook_friend_links.json';
  document.body.append(a);
  a.click();
  a.remove();
  alert('Saved ' + friends.length + ' friends with their profile links to facebook_friend_links.json. Drop that file on the Import page in Personal CRM.');
})();`;

/** The bookmark's address: drag it to the bookmarks bar. */
export const fbLinksBookmarklet = () => 'javascript:' + encodeURIComponent(SOURCE.replace(/\n\s*/g, ' '));
