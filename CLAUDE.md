# How we work on GroSplit

**Read `SPEC.md` before any task.** It is the source of truth for what the app does. If the
code and SPEC.md disagree, SPEC.md wins (except items under its *Open questions*). Report the
disagreement rather than silently picking a side.

## Team

| Who | Model | Owns (may edit) | Does |
| --- | --- | --- | --- |
| **Orchestrator** (main session) | Opus | `SPEC.md`, `CLAUDE.md`, `README.md`, git, `.claude/` | Plans, splits work, reviews every diff, integrates, talks to the owner |
| `frontend-designer` | Sonnet | `public/` | Design per the handoff, intuitive UX |
| `backend` | Sonnet | `*.js` at root, `*.test.js`, `Dockerfile`, `fly.toml`, `package.json`, `scripts/` | Correctness, privacy, Telegram, data |
| `adversarial-tester` | Opus | nothing (read-only) | Tries to break a change before it ships |
| `visual-tester` | Haiku | nothing (read-only) | Screenshots every screen, checks against the handoff |

Stay in your lane. If your task needs a change in someone else's files, describe the change in
your report. Don't make it.

## Workflow

1. **Talk to the owner first.** The orchestrator presents the plan and waits for a go-ahead
   before starting multi-step work.
2. Orchestrator picks backlog items from SPEC.md §11 and briefs the right bot(s).
   Frontend and backend may run in parallel only when their files don't overlap.
3. The builder bot implements, adds a test that fails without the fix, and runs `npm test`.
   The frontend bot checks its own screens with `node scripts/shots.js` as it works.
4. **Gate before every push**: `visual-tester` (if anything under `public/` changed since the
   last push) and `adversarial-tester`. A FAIL from either blocks the push.
5. `adversarial-tester` also runs straight after **any change to money** (`split.js`,
   `receiptView`, items, tax), **privacy** (auth, membership, webhook, logging) **or the
   Telegram poll**, without waiting for the push.
6. Orchestrator reviews the diff, ticks the backlog item in SPEC.md, and explains the step to
   the owner, both technically and in plain English.
7. **Nothing is pushed or deployed without the owner's go-ahead.**

## Rules for every bot

- Zero runtime dependencies. All money in integer cents.
- Never run anything against `./grosplit.db`. It holds real data. Tests and screenshots
  use a temp DB (see `server.test.js`, `scripts/shots.js`).
- Never print, log or copy values from `.env` or `.env.production` (the real bot's token).
  The laptop only ever runs the test bot; the real token belongs on Fly only.
- Schema changes need an in-place migration (SPEC.md §4).
- Match the surrounding code style. Short comments that explain *why*.
- Finish with a report: what changed (file:line), how it was verified, anything left open, and
  **questions for the owner** (the orchestrator relays them; bots can't ask the owner directly).

## Commands

```bash
npm test                 # all tests, no network
npm run demo             # local demo: DEV=1, fake household, ./demo.db, no Telegram
npm run dev              # the TEST bot (@gro_split_test_bot) from .env, ./test.db, auto-restart
node scripts/shots.js    # screenshots of every screen → .shots/
powershell -ExecutionPolicy Bypass -File scripts/phone.ps1   # the owner's mirrored phone → .shots/phone.png
```

The owner mirrors their iPhone to the laptop (uxplay, "AirPlay Video Stream" window) and has
OK'd screenshotting it any time. That shows the real Mini App inside real Telegram. It can't
tap: the owner drives, we look. Ask the owner to keep `.env` closed in the editor when
capturing the full screen.
