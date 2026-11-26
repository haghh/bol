Bol for Windows: an Electron + TypeScript + React port of the macOS app in ../src. See README.md for the layout.

- Use npm in this folder: `npm run typecheck`, `npm test`, `npm run brain` (terminal brain), `npm run dev` (app).
- The brain in src/main/brain was ported from ../src/typescript. Keep its logic and style close to upstream so
  upstream fixes can be carried over; change only what Windows or Node needs. It runs on Node (Electron main),
  not Bun: no `Bun.*` APIs.
- Windows-specific behaviour lives in src/main/native (PowerShell host + Win32). It can't be exercised on Linux:
  say so when a change there is untested.
- The Claude Code backend drives the user's installed Claude Code with their subscription login. Never bundle
  Claude Code, scrape web sessions, or reuse tokens outside official CLIs.
- Dependencies are pinned to exact versions at least 7 days old.
- Style: tabs, no semicolons, single quotes, width 120; functions take one object argument; booleans are
  `is…`/`has…`; compare to null with `== null`.
