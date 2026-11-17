# Personal CRM

A website for keeping track of everyone you've met: how you met, when, how close you are, birthdays, notes, and how often you want to keep in touch. It works on desktop and phone browsers.

Import your contacts, then import again later. Anyone new lands in your **Inbox** so you can note how you met while it's fresh.

Turn on **Professional mode** (Import & settings) to get a **Pipeline** board for leads and potential clients:
- one color-coded group per stage: New lead → Contacted → Meeting set → Proposal sent → Negotiating → Won / Lost
- status and priority labels you click to change
- company, deal value, next step and due-date cells you edit in place
- a Kanban view where you drag cards between stages
- a lifecycle timeline on each person

## Run it

```sh
npm install
npm run dev        # http://localhost:5173 — the terminal also prints a Network URL you can open on your phone (same Wi-Fi)
```

`npm run build` writes a static site to `dist/`. You can host it on any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages) with no server or rewrites needed.

**Live site:** https://jasenzhang1.github.io/Personal-CRM/. Every push to `main` rebuilds it (see `.github/workflows/deploy.yml`). The site holds only code. Your contacts stay in whichever browser you use it in.

## Importing contacts

The **Import & settings** page has a button for each source that opens the right export page, plus step-by-step instructions.

| Source | How |
| --- | --- |
| Gmail & Google Contacts | **Live sync** with a "Sync with Google" button. It pulls your saved contacts and everyone you've emailed. One-time setup: create a free Google OAuth Client ID (walkthrough on the page). |
| iPhone | icloud.com/contacts → select all → Export vCard → drop the `.vcf` |
| LinkedIn | Request the "larger data archive" (it includes Connections) → drop the `.zip` |
| Instagram | Download your information → Followers and following, JSON → drop the `.zip` |
| Facebook | Download your information → Friends, JSON → drop the `.zip` |
| Discord | Settings → Data & Privacy → Request all of my data → drop `package.zip` |

Drop whole `.zip` exports as-is; only the contact lists inside are read. Instagram, Facebook, LinkedIn and Discord don't let outside apps read friend lists, so for them the export file is the only way in.

The **first** import from each source files everyone under **Older connections**. Later imports put only newly added people in the **Inbox**. The same person from several sources is merged by email, phone number, or an unambiguous name match. Imports only fill in blank fields and never overwrite what you wrote.

## Ranking and closeness scores

Every person has a Beli-style **0–10 closeness score**, and the People list sorts by it.

- **Rank** page: pick a tier (Inner circle, Good friends, Acquaintances), then answer "who are you closer to?" a few times. A binary search places them, so even with 200 people ranked it takes about 7 taps. Their spot in the tier sets the ranking part of the score.
- **Activity** makes up the rest: messages, calls (longer calls count more; a 1-hour call counts a lot) and hangouts you log on someone's page. It fades with a 60-day half-life, so scores fall when you drift apart and rise when you reconnect.
- **Quick check-in**: 6 matchups that re-check the people you confirmed longest ago and move anyone who's grown closer.
- **Drifting apart**: close friends you used to talk to but haven't lately.

Chat counts come from the Instagram, Facebook (Messenger) and Discord exports when they include Messages. Only one-on-one chats count. Only daily message counts and call lengths are kept, never message text. A chat is matched to a person by an earlier link, then by Instagram username or Discord user ID, then by exact name. A busy chat (20+ messages) with no match becomes a new person under Older connections. Re-importing a newer export replaces the old counts instead of adding to them.

## Where data lives

Everything is stored in a SQLite database inside your browser (IndexedDB), on that device only. Nothing is uploaded. Each address is its own separate storage: `http://localhost:5173` and the Network address (`http://192.168…:5173`) don't share data, and neither do different browsers or devices. To move data, use **Download backup** and then **Restore from backup**. Clearing the browser's site data erases it, so back up now and then. If the browser ever refuses to save, a red warning appears.

## Development

```sh
npm test           # parser, merge and pipeline tests (Node's built-in test runner + node:sqlite)
npm run typecheck
```

- `src/pages`: screens
- `src/db`: schema, queries, and the browser SQLite adapter (sql.js + IndexedDB)
- `src/sync`: import parsers and merge logic
