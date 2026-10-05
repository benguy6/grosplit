# GroSplit — Source of Truth

This file is how GroSplit must work. If the code disagrees with this file, the code is wrong,
unless the item is listed under **Open questions**. Only the orchestrator edits this file, and
product decisions in it need the owner's (Vansh's) OK.

`README.md` is for humans setting the app up. `CLAUDE.md` is how we work. This file is *what*
we are building.

---

## 1. What it is

Splits grocery bills for one shared household. One housemate shops and pays. The app reads
the receipt, lets them fix every line, optionally runs a Telegram poll so people can opt out of
specific items, computes exact shares, and hands off per-person amounts to type into Tricount.

**It is not:** a payments app (never moves money), a Tricount replacement, a chat app, or a
multi-household service. **One deployment = one bot = one household = one Telegram group.**

It runs as a **Telegram Mini App**: a web page inside Telegram, opened from the bot's menu
button or the pinned link in the group. The bot is invisible plumbing: it posts polls and
catches votes. Nobody types commands at it.

## 2. The flow (happy path)

1. Bot is added to the household group → household is created/linked, bot posts a pinned
   "Split groceries now" link.
2. Each housemate opens the Mini App once → they become a member (only if they're in the group).
3. Shopper taps **+** → names the store, picks who paid (the **grocer**) → scans or uploads
   the receipt (or enters lines by hand).
4. **Review**: AI-unsure lines are flagged amber; any line can be edited, added or removed. Tax
   is read off the receipt and can be overridden, split by share or evenly, or not split.
5. **Poll (optional)**: grocer picks up to 9 items people might want out of → one Telegram poll.
6. **Votes**: housemates tick what they're NOT in on. Anyone who doesn't vote stays in.
7. **Split**: per-person shares. Only the grocer can **lock** it.
8. **Export**: copy each person's amount into Tricount.

## 3. Architecture

| File | Role |
| --- | --- |
| `split.js` | The split algorithm. Pure, no I/O. The most important file. |
| `db.js` | SQLite schema + queries via `node:sqlite` |
| `telegram.js` | `initData` verification (trust boundary) + Bot API calls |
| `ocr.js` | One OpenAI vision call with a strict JSON schema |
| `server.js` | HTTP routing, auth, API, webhook, poll lifecycle |
| `seed.js` | Demo data, DEV mode only |
| `public/` | The Mini App: `index.html`, `styles.css`, `app.js` (vanilla JS, one state object, one render) |
| `scripts/shots.js` | Screenshots every screen at phone size (visual testing) |
| `design_handoff_grosplit/` | The design reference. Read-only. |

**Rules**
- **Zero runtime dependencies.** `node:sqlite`, `node:test`, `fetch`, `--env-file` cover it.
  Adding an npm package needs the owner's OK.
- **All money is integer cents.** Never floats for stored or transmitted amounts.
- **Node ≥ 22.13** (`node:sqlite` unflagged). Production image uses Node 24.
- Hosted on **Fly.io**, region `sin`, **exactly one machine** (SQLite lives on its volume),
  scale-to-zero. Nothing may depend on a timer running in the background.

## 4. Data model

SQLite, one file. Timestamps are unix seconds. Existing production data exists, so **every
schema change needs a migration** that upgrades an existing database in place (`CREATE TABLE IF
NOT EXISTS` does not add columns to an existing table).

- `household` — name, telegram_chat_id, poll_window_hours, settings
- `member` — name, initial, avatar_color, telegram_handle, telegram_user_id
- `receipt` — store, created_at, grocer_id, tax_cents/enabled/mode, status, poll ids,
  poll_closes_at, printed_total_cents
- `item` — name, price_cents (**line total**, may be negative), quantity (display only),
  ai_flagged, ai_guess, position
- `polled_item` — which items are in the poll, and their option index
- `opt_out` — (receipt, item, member)
- `poll_voter` — who has voted

## 5. Money rules (normative)

```
per item:  participants = all members − opt-outs   (opt-outs count only on polled items)
           each participant += price / participants.length
tax:       'pro'  → member.amount / subtotal × tax   (falls back to even if subtotal is 0)
           'even' → tax / members
rounding:  every non-grocer rounds to whole cents; grocer = total − everyone else
```

Invariants, always tested:
1. **Shares sum to the total exactly.**
2. **No item ever has zero participants.** The grocer can't opt out, and non-voters stay in.
3. **A locked split never changes.** Not when members join or leave, not when late votes
   arrive, not when anything else is edited.

`quantity` is never a multiplier. Coupons and deposits are negative-price items.

## 6. Privacy and trust rules

| Boundary | Rule |
| --- | --- |
| Every `/api/*` call | Caller is identified **only** by Telegram `initData`, HMAC-verified with the bot token, max 24h old. Never trust a client-sent user id. |
| Becoming a member | **The house = the Telegram group.** Allowed only if Telegram confirms the person is in the household's group (`getChatMember`). This applies to poll votes too: polls can be forwarded, so a vote alone is not proof. *(B29)* Anyone else gets a polite "ask to be added to the group" screen and **no data**. |
| Leaving | Someone who leaves (or is removed from) the group stops being a member: no access, and not part of any new receipt. Their past locked splits stay as they were. No manual "remove" button. Members are deactivated, never deleted (locked splits reference them). *(B15)* |
| DEV mode | Only when explicitly enabled with `DEV=1`. A missing bot token without `DEV=1` = **refuse to start**. Never on Fly. |
| Webhook | Requires the secret header. The secret is stable across restarts. |
| Data scope | A member sees only their own household's data. |
| Secrets | `.env` is never committed, printed, logged or copied into the Docker image. |
| Logs | No receipt contents, no tokens, no full `initData` in logs. Names are OK. |
| Receipt photos | Sent to OpenAI for reading, never stored by us. |

**Roles within the household** *(owner decision, for now)*:
- Any member may create receipts, edit lines/tax during review, and run or close a poll.
- **The receipt's creator or its grocer** may change who the grocer is (while in review), or
  delete the receipt (while in review). *(B33)*
- **Only the receipt's grocer** may lock the split.

## 7. Receipt lifecycle

```
 review ──send poll──▶ polling ──close (manual / deadline / everyone voted)──▶ review ──lock (grocer)──▶ confirmed
   ▲                                                                              │
   └──────────────────────────── (edits allowed) ◀───────────────────────────────┘
```

- **review**: everything editable. Editing items must keep item identity, so existing
  opt-outs on unchanged items survive. Deleting an item drops its own opt-outs only.
 
- **polling**: items, tax and grocer are locked. Votes are accepted only while polling and
  before `poll_closes_at`.
- Closing a poll stops it in Telegram. A second poll on the same receipt **replaces** the first
  completely: old polled items, opt-outs and voters are cleared.
- **confirmed**: read-only forever. The shares are **frozen at lock time** and served from the
  frozen copy. No votes, edits or membership changes affect it.

## 8. Telegram poll rules

- Multi-answer, **non-anonymous** (anonymous polls never send `poll_answer`).
- Options = the picked items (max **9**) + a final **"✅ I'm in on everything"** option. That
  option keeps the poll at ≥ 2 options (Telegram's minimum) and lets people who want everything
  actually vote. Ticking it alongside items = the items win (they're out of those).
- Option text ≤ 100 chars, question ≤ 300.
- Deadline = `poll_window_hours` (1–48, default 4). There's no background timer (scale-to-zero),
  so the deadline is enforced by (a) rejecting votes that arrive after it and (b) stopping the
  Telegram poll on the next request after it.
- When every non-grocer has voted, the app auto-advances to the split after ~1.5s.
- Group invite button = a `url` button to `https://t.me/<bot>?startapp` (`web_app` buttons don't
  work in groups). Needs "Configure Mini App" set in BotFather.

## 9. Design rules

The handoff (`design_handoff_grosplit/README.md` plus `GroSplit App.dc.html` for exact values)
is the visual reference. Non-negotiables:

- **One accent element per screen**: the primary action *or* the hero number, never both.
- **Every money figure is JetBrains Mono with `tabular-nums`.** UI voice is Space Grotesk.
- Receipt surfaces: radius 0, torn edges, dotted leaders, double rule under totals. No fake
  thermal-print effects.
- Back always exits to Receipts. The flow strip is the way to step back, and unreachable steps
  toast. The tab bar appears only on Receipts and House.
- Voice: housemate, not bank. Never "transaction", "settlement" or "participant".
- Motion: recalculated numbers count up over 600ms, toast 2200ms, nothing loops or pulses.
- Minimum hit target 44px. Text contrast ≥ 4.5:1 for anything carrying information.

**It runs inside Telegram's webview**, so also:
- Must fit 360–430px wide with **no horizontal scroll** and nothing clipped.
- Respect safe areas (`env(safe-area-inset-*)`) and Telegram's own header.
- Must work with the phone keyboard open (sticky footers can't cover inputs).
- Native inputs only: real camera via `<input capture>`, real number keypad.

**Deliberate deviations from the handoff** (keep these):
1. Tax is read off the receipt, not a fixed 9%.
2. Poll cap is 9 items + "I'm in on everything" (Telegram allows 10 options).
3. `quantity` and negative prices exist.
4. Items lock while a poll is live.
5. `--ink-meta` replaces ink-25 for text that carries money (contrast).
6. No nav rail. Deep-link hashes (`#review/1`) replace it.

## 10. Testing

| Where | Checks | Who |
| --- | --- | --- |
| `npm test` | Logic, API, invariants, trust boundary | Every bot, before reporting done |
| `node scripts/shots.js` | Every screen screenshotted at 390×844 in DEV mode | Frontend bot while working; visual tester before each push |
| Laptop + test bot | Real sign-in, bot, poll, votes with @gro_split_test_bot in a test group (`npm run dev`, `./test.db`, needs an HTTPS tunnel for the Mini App) | Owner + orchestrator |
| Telegram Desktop / phone on Fly | Same, with the real bot against the deployed app | Owner + orchestrator, before a release |
| Phone (mirrored) | Camera, safe areas, keyboard, real webview layout | Owner + orchestrator, before a release |

Every bug fix ships with one test that fails without the fix.

## 11. Backlog

Ranked. **P0** = wrong money or a privacy hole. **P1** = broken in production. IDs match the
original review.

### P0
- [x] **B1** Editing any item deletes and reinserts every row, which wipes all opt-outs. → Update in place by item id.
- [x] **B2** Locked splits change when members join (computed live). → Freeze shares at lock.
- [x] **B3** Any Telegram user can join the household. → `getChatMember` check before enrolling (`isInChat` exists, unused).
- [x] **B4** A missing bot token silently disables auth. → Explicit `DEV=1`, otherwise refuse to start.
- [x] **B5** Anyone can PATCH themselves to grocer, then lock. → Only the current grocer changes grocer, validated in-household.

### P1
- [ ] **B6** A 1-item poll fails (Telegram needs ≥ 2 options). → "I'm in on everything" option.
- [ ] **B7** People in on everything can't vote. → Same option.
- [x] **B8** Votes accepted after the deadline and after lock. → Check status + `poll_closes_at` in `applyPollAnswer`.
- [x] **B9** Export CSV link gets a 401 in Telegram (no `initData` header). → Remove CSV export (button + endpoint); copying is enough.
- [x] **B10** Webhook secret is regenerated every boot. → Derive from the bot token when unset.
- [ ] **B11** Fly may run 2 machines, which means 2 databases. → README deploys with `--ha=false` and checks `fly machines list` / `fly volumes list`. Tick after the first deploy is verified.

### P2
- [x] **B12** "Auto-flag staples" and "Round to nearest cent" toggles do nothing. → Remove both from the UI and the API (DB columns can stay; unused).
- [ ] **B13** A new scan wipes hand-entered lines and the typed store name. → Confirm before replacing; never overwrite a typed store name.
- [x] **B14** Re-polling keeps stale voters and opt-outs. → Clear on new poll (§7). Matters more now that B1 keeps opt-outs.
- [ ] **B15** Members can never be removed. → Someone who left the group stops being a member (§6). Detect it (leave updates and/or a `getChatMember` re-check when a receipt is created).
- [x] **B16** CSV escaping. Obsolete: CSV is being removed (B9).
- [ ] **B17** OpenAI call has no timeout. Photos aren't downscaled (up to 12MB, HEIC). → Timeout + client-side resize to JPEG.
- [ ] **B18** `npm start` ignores `.env`.
- [ ] **B19** `engines` says ≥ 22.5. Should be ≥ 22.13.
- [x] **B26** Apparent horizontal overflow at 390px. Not an app bug: headless Chrome can't go below ~500px wide, so the old screenshots were cropped. `scripts/shots.js` now emulates a true phone viewport and prints `OVERFLOW` if a page is wider than the screen.
- [x] **B27** Votes screen re-renders every 4s and replays the fade-in on every tile and avatar, so the whole screen flickers while a poll is open. → Only newly arrived votes animate (handoff: "Poll vote landing: 8px slide-in").

### Found by the round-1 adversarial test
- [x] **B28** (P1) A price or tax ≥ 1e17 (or Infinity) is stored and then every read of that receipt fails, so `/api/state` returns 500 for the whole house, permanently. → Validate money at the boundary: safe integer, |cents| ≤ 10,000,000.
- [x] **B29** (P0) A poll vote enrols the voter without the group check, and they then get full API access. → `isInChat` before enrolling from a vote.
- [x] **B30** (P1) `npm run dev` with the real token re-points or deletes the production webhook, so production stops getting votes. → Two bots: the laptop runs the TEST bot (@gro_split_test_bot) by long-polling; production runs the real bot (@gro_split_bot) by webhook. Register the webhook only on Fly (URL defaults to `https://$FLY_APP_NAME.fly.dev`). Off Fly, refuse to long-poll a bot that already has a webhook (it belongs to a deployed app).
- [x] **B31** (P2) A vote after the deadline is ignored, but the poll stays open in Telegram. → Sweep expired polls in `handleUpdate` too.
- [x] **B32** (P2) A housemate with an out-of-date screen silently deletes lines someone else just added. → Client sends the ids it knew about (done). Still open: a stale screen can bring back a deleted line, or overwrite a different line that reused an id. → 409 "someone else changed this" when `knownIds` ≠ current ids; client reloads.
- [x] **B33** (P2) Picking the wrong payer by mistake can't be undone, and the receipt can be stuck forever. → Creator or grocer can change the payer or delete the receipt while in review (§6).
- [x] **B34** (P3) Malformed items (`[null]`) give a 500 with an internal error message. → 400.

### Found by the round-1b adversarial test (verdict PASS)
- [x] **B35** (P2) An armed "Delete receipt" confirmation carries over to the next receipt opened; one tap deletes the wrong receipt. → Reset sheet/confirm state on every screen change.
- [x] **B36** (P2) After a deploy, phones with the old `app.js` cached for up to 1h can't edit lines (server now requires `knownIds`). → Serve app.js/styles.css with `no-cache`.
- [x] **B37** (P3) A vote that arrives while a newcomer's group check is in flight can land after a lock, or out of order with a quick retraction. → Re-check status/deadline/poll id after the await; serialise answers per user.
- [x] **B38** (P3) An object/array in `quantity` or `aiGuess` gives a 500. → Coerce to number/string or null.

### Found by the pre-push adversarial test (verdict PASS)
- [ ] **B39** (P2) B32 still slips when SQLite reuses a freed item id (delete the highest line, add another): the id set looks unchanged, so a stale screen can overwrite the new line. → `receipt.items_version` bumped on every item write, sent back by the client; mismatch = 409 stale.
- [ ] **B40** (P3) Every toast shows a ✓, including errors ("✓ Someone else just changed this receipt"). → `toast(msg, kind)`, no check for errors.

### P3: housekeeping
- [x] **B20** No commits yet. → First commit pushed to github.com/benguy6/grosplit (private).
- [x] **B21** `.env.example` emptied in the working tree (staged copy is fine).
- [x] **B22** README stale: auto_stop, test count, privacy mode, unused `TELEGRAM_GROUP_CHAT_ID`.
- [x] **B23** No `.dockerignore`. Scratch scripts and tests are copied into the image.
- [x] **B24** Scratch files (`.polltest.js`, `.verify.js`, logs, `demo.db`). `*.log` not ignored.
- [ ] **B25** Small cleanups: tests leave temp `.db` files in %TEMP% on Windows, palette and poll cap duplicated in `app.js`, dead `void v`, bad poll-window input silently resets, oversized upload resets the connection instead of a 413.

## 12. Open questions (owner decides)

None right now.

Answered: Q1 (remove both toggles), Q2 (house = group), Q3 (anyone edits, for now), Q4 (one household, for now),
Q5 (no CSV). See the decision log.

## 13. Decision log

| Date | Decision |
| --- | --- |
| 2026-10-04 | Project run by an orchestrator + 4 bots (see `CLAUDE.md`). |
| 2026-10-04 | Adversarial test gates every push, plus any change to money, privacy or Telegram code. Not every commit. |
| 2026-10-04 | Owner: visual tester runs once before each push, not after every change. The frontend bot screenshots its own work. |
| 2026-10-04 | Locked splits are frozen at lock time (§7). |
| 2026-10-04 | Poll gets an "I'm in on everything" option; item cap 9 (§8). |
| 2026-10-04 | DEV mode must be explicit (`DEV=1`) (§6). |
| 2026-10-04 | Owner: the house = the Telegram group. Leaving the group = leaving the house (§6). |
| 2026-10-04 | Owner: anyone in the house may edit receipt lines, for now. |
| 2026-10-04 | Owner: one household per deployment, for now. |
| 2026-10-04 | Owner: no CSV export. Copying amounts into Tricount is enough. |
| 2026-10-04 | Owner: the receipt's creator or grocer can change the payer or delete the receipt while it's in review. |
| 2026-10-04 | Owner: two bots. Laptop = test bot (@gro_split_test_bot, token in `.env`, `./test.db`). Production = real bot (@gro_split_bot, token kept in gitignored `.env.production`, set as a Fly secret). |
| 2026-10-04 | Owner: OK that a receipt's creator can make themselves the payer and lock (anyone can already create a receipt naming themselves as payer). |
| 2026-10-04 | Owner: code lives at https://github.com/benguy6/grosplit — push there after the gates pass. |
| 2026-10-04 | Owner: remove the "Auto-flag staples" and "Round to nearest cent" switches. Rounding always happens; staples can return if people game the poll. |
