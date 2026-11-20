# Working on this repo

- Commit and push every change as soon as it's made, without asking. Small commits are fine.
- The app's data is never stored in this repo (it is public via GitHub Pages). It lives in the owner's private data repo through the in-app GitHub sync (`src/lib/cloud.ts`, `src/sync/github.ts`).
- Before pushing: `npm run typecheck && npm test`.
