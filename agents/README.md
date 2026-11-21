# Agents

Scheduled jobs that run on your own computer and keep the CRM up to date without you opening the app. They change the database the same way another device would: download `crm.sqlite` from your private data repo, update it with the app's own import code, and commit it back. Every run is a commit, so you can undo any of them from the data repo's history.

Nothing personal is stored in this repo. Settings, the agent's browser profile, downloaded archives (the last 3 only), logs and debug screenshots all live in `%USERPROFILE%\.personal-crm`.

## LinkedIn (daily)

LinkedIn has no API for your connections, so the agent uses LinkedIn's own **Get a copy of your data** page in a real Edge window, signed in with a browser profile you log into yourself. Each day it:

1. opens that one page (it never visits anyone's profile),
2. downloads any archive that's ready and imports its `Connections.csv`: new connections land in the **Inbox**, people you already have are matched, and sure-thing name fixes are applied,
3. requests a new "larger data archive" if the last request was at least a day ago and none is being prepared. LinkedIn asks for your password at this step.

Since an archive takes LinkedIn from a few minutes to a day to prepare, new connections usually show up in the CRM one or two days after you connect.

> **Risk:** automating LinkedIn is against its User Agreement, and LinkedIn can restrict accounts it thinks are bots. The agent keeps this as small as it can (one settings page, a few clicks with human-like pauses, at most one request a day), but the risk is real. To lower it, set `"requestEveryDays": 7` in `%USERPROFILE%\.personal-crm\config.json`.

### Set up (once)

```powershell
powershell -ExecutionPolicy Bypass -File agents\setup.ps1
```

It asks for:
- your data repo (`owner/name`, the same one as in Import & settings),
- a GitHub fine-grained token with **Contents: Read and write** on that repo,
- your LinkedIn password (optional; without it the agent only downloads archives you request yourself).

The token and password are encrypted with Windows DPAPI, so only your Windows account on this computer can read them. Next, a window opens so you can sign in to LinkedIn. Then the script registers a **Personal CRM - LinkedIn** task in Task Scheduler that runs daily at 09:00, or as soon as the computer is on if it was asleep at that time. Use `-Time 07:30` to pick another time.

### Everyday commands

| Command | What it does |
| --- | --- |
| `npm run linkedin -- --status` | what the last run did |
| `npm run linkedin -- --headed` | run now, with the browser visible |
| `npm run linkedin -- --login` | sign in again (Windows shows a notification when this is needed) |
| `npm run linkedin -- --import path\to\archive.zip` | import an archive you downloaded yourself |
| `--dry-run` | import without committing, to see what would change |
| `agents\setup.ps1 -Uninstall` | remove the daily task |

Log: `%USERPROFILE%\.personal-crm\logs\linkedin.log`.

### When something goes wrong

- **"needs-login"**: LinkedIn signed the agent out or wants a security check. Run `npm run linkedin -- --login` and finish the check yourself in the window.
- **"unrecognized"**: LinkedIn changed its page and the agent couldn't find the buttons. It saves a screenshot and the page's HTML in `%USERPROFILE%\.personal-crm\linkedin\debug`. Fix the selectors in [`linkedin/browser.ts`](linkedin/browser.ts).
- **An import vanished**: if a phone or computer had unsaved changes in the app while the agent committed, that device's version wins (same as any two devices). The agent's commit is still in the data repo's history. Run `--import` on the latest file in `%USERPROFILE%\.personal-crm\linkedin\archives` to bring it back.
