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
| iPhone | Easiest (iOS 16+): Contacts app → Lists → touch and hold All Contacts → Export → drop the `.vcf`. This has every contact on the phone, no iCloud needed. Or icloud.com/contacts → select all → Export vCard, which only has contacts synced to iCloud. The Import page explains how to turn on iCloud Contacts if some are missing. |
| LinkedIn | Request the "larger data archive" (it includes Connections) → drop the `.zip` |
| Instagram | Download your information → Followers and following, JSON → drop the `.zip` |
| Facebook | Download your information → Friends (JSON or HTML) → drop the `.zip`. Tick Personal information too to bring in the phone contacts you once uploaded to Facebook. |
| Discord | Settings → Data & Privacy → Request all of my data → drop `package.zip` |

Drop whole `.zip` exports as-is; only the contact lists inside are read. Instagram, Facebook, LinkedIn and Discord don't let outside apps read friend lists, so for them the export file is the only way in.

The **first** import from each source files everyone under **Older connections**. Later imports put only newly added people in the **Inbox**. The same person from several sources is merged by email, phone number, or an unambiguous name match. Imports only fill in blank fields and never overwrite what you wrote.

## Cleaning up names

Instagram's followers and following lists only have usernames. Real names are read from your chats and from the smaller lists that include them (Close Friends, follow requests, recently unfollowed). Even so, after an import some people are named like `john.smith_99` or `jackiezhang26`. **Clean up names** (button on People, or the link after an import) suggests a proper "First Last" for each one. Suggestions come from the name they use in your chats, from fixing capitals ("JOHN SMITH"), and from splitting the username using common first and last names.

- **Sure fixes** (a chat name, or a known first + last name like `eileen_chen7` → Eileen Chen) are applied automatically after every import. You can turn this off on the page.
- **Guesses** (`zongyundeng` → Zongyun Deng) wait for you: edit, **Save**, **Keep as is**, or **Apply all**.
- Names you type yourself, on that page or on someone's own page, are never changed again.

## Merging duplicates

The same person can end up in here twice, for example as an Instagram follower (`jackiezhang26`) and as a chat contact (Jackie Zhang). **Merge duplicates** (button on People, or the link after an import) lists likely pairs. It matches by the name someone uses in your chats, a username that spells out their name, exactly the same name, or the same email or phone. Pick the name to keep and press **Merge**, or **Not the same person** to stop seeing that pair. **Merge all** merges every likely pair at once. It keeps the proper "First Last" name and skips anyone who matches more than one person.

Imports also try to avoid duplicates in the first place. An Instagram chat that doesn't match anyone by name is attached to the follower whose username spells that name (`jackiezhang26` → Jackie Zhang) or whose Instagram name matches, as long as exactly one follower fits. You can also merge anyone by hand from their page with **Merge with someone…**.

Merging keeps everything from both copies: blank details are filled in, notes are combined, and tags, chats and call logs, rankings, pipeline history and import links all move to one person. Later imports of either account land on that person. A merge can't be undone, so download a backup before merging a lot at once.

## Instagram followers

**📸 Followers** (on People, or the link after an Instagram import) shows:

- **Don't follow you back**: accounts you follow that don't follow you. Many are celebrities, brands or clubs, so there's an **Archive everyone on this page** button.
- **You don't follow back**, **New followers**, and **You unfollowed** (Instagram's own list plus changes between exports).
- **Unfollowed you**, with the window it happened in. Instagram never says who unfollowed you, so every import saves a snapshot of your followers and compares it with the previous one. The first export is the starting point. Download a fresh export every few weeks and drop it in. Exports dropped out of order are handled: an older one never undoes a newer one.

## Archiving

Archive people who aren't really people (clubs, shops, brands) or who don't matter to you anymore. They're hidden from People, Rank, name cleanup and duplicates, but kept, so a future import doesn't add them back. Ways to archive:
- **🗄 Archive** on someone's page
- **☑ Select** on People, then **Archive** in bulk. The **Looks like an organization** filter finds likely clubs and businesses.
- **Not a person** on Clean up names
- the Followers page

Find them again under the **Archived** filter, where you can **Unarchive**.

## Birthdays and cities

- **🎂 Birthdays** (from Reminders) shows the next 30 days, everyone by month with the age they're turning, and a quick way to add birthdays for your closest people. **📅 Add to my calendar** downloads a calendar file of every birthday, repeating yearly with reminders the day before and that morning. Open it on your iPhone and tap *Add all*. A website can't send notifications by itself, but your calendar can.
- **City** on each profile, filled automatically from phone and Google contact addresses. People can be filtered by city and shows it under each name. **☑ Select** → **📍 Set city** sets it for many people at once.

## Profile links and pictures

The People list shows each source as its icon. It's in color and clickable when there's a link to their profile (Instagram, LinkedIn, Discord, Google Contacts, or tap to call), and gray when that source only gave a name (Facebook friends, for example). Exports don't include other people's profile pictures, and Instagram blocks websites from loading them. To add one, open their Instagram (or LinkedIn), right-click the picture → *Copy image*, and press Ctrl+V on their page. You can also drag the picture in.

## Profile pictures

The People page shows **📸 how many people have pictures and when pictures were last updated**, and each photo on a person's page shows its date. **📸 Fetch pictures** gets every picture that can be fetched automatically:
- **Gravatar**: the free profile picture people set up through WordPress, GitHub, Slack and others. It's checked with a scrambled (SHA-256) version of each email, never the email itself.
- **Google**: if Sync with Google is set up, re-syncing brings in contacts' Google profile photos.

The rest come from the monthly photo round below.

## Monthly photo round

Instagram, LinkedIn and Facebook exports never include other people's profile pictures, and automated scraping breaks LinkedIn's and Instagram's terms and risks your account. Instead, **📸 Photo round** (from Reminders) speeds up doing it by hand:

1. It lists everyone with an Instagram or LinkedIn link and no picture, closest people first, Instagram before LinkedIn.
2. **Open Instagram** (or press Enter) opens their profile. Every profile reuses the same tab.
3. Right-click their picture → *Copy image*, come back and press **Ctrl+V**. The picture is saved, and the next person comes up with their profile already open.
4. **No picture to copy** / **Still the same** skips them for a month. **Skip** asks again next time.

Tick *Also re-check people who already have a photo* to refresh pictures that may have changed. Reminders shows the round once a month, and **📅 Remind me monthly** adds a calendar reminder on the 1st.

## The People table

- **Numbered rows**, numbered in the current order.
- **⚙︎ Columns** shows or hides Type, Tags, Closeness, Connected on, Phone, Email, Company, City, How you met, Birthday, Last talked and Added. The choice is remembered. On wide tables the number and name stay pinned while you scroll sideways.
- **Sort by any column**: click its header, and click again to reverse. Or use the Sort menu and ↑/↓ on a phone. Empty values always sort last, and birthdays sort by calendar date.
- **Filter** by status, type, tag, city and platform, or search across names, tags, handles, companies, cities and notes.
- **+ in the Tags column** adds a tag to someone. Pick one you've used before, or type a new one to create it.

## Ranking and closeness scores

Every person has one **0–10 closeness score**, and every list sorts by it. There are no fixed buckets like "inner circle": friendships change, so scores do too.

- **Starts as a guess.** Before you do anything, everyone is scored from how much you talk (messages, calls, and hangouts you log). Guesses look faded.
- **The game sets it.** On the **Rank** page, press **Play** and answer "who are you closer to?" Each round places one person with a binary search, so about 7–10 taps even with hundreds of people. Their new score is halfway between the two people they landed between, so the order and the scores always agree. Keep playing as long as you like. The game starts with the highest guesses, then re-checks anyone whose score has moved.
- **Then it keeps moving.** After you place someone, their score follows changes in how much you talk, at half speed. A 1-hour call pushes it up, and going quiet for months pulls it down. **Growing closer** and **Drifting apart** list the biggest moves.
- **Big changes.** **Re-rank** places someone again. **Not close anymore** (on their page or during the game) drops them straight to 0.

Chat counts come from the Instagram, Facebook (Messenger) and Discord exports when they include Messages. Only one-on-one chats count. Only daily message counts and call lengths are kept, never message text. A chat is matched to a person by an earlier link, then by Instagram username or Discord user ID, then by exact name. Then by the follower whose username or Instagram name fits. Chats never add people: a chat with no match is skipped, because chats don't include usernames and the person would have no profile link. If an older version added people from chats, a button on People removes them. Re-importing a newer export replaces the old counts instead of adding to them.

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
