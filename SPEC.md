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
- Hosted on **Fly.io**, region `iad` (US East, near the house), **exactly one machine** (SQLite lives on its volume),
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
- **Any number of items can be polled.** They're split into as many Telegram polls as needed,
  up to 9 items each (balanced, e.g. 14 → 7 + 7), titled "<store> · 1 of 3". Each poll ends with
  a **"✅ I'm in on all of these"** option, which keeps every poll at ≥ 2 options (Telegram's
  minimum) and lets people who want everything actually vote. Ticking it alongside items = the
  items win (they're out of those).
- All of a receipt's polls share one deadline and close together. A vote or retraction in one
  poll only touches that poll's items. A person counts as **voted** once they've answered every
  poll of the receipt; the Votes screen shows partial progress ("2/3").
- If sending any poll fails, the ones already sent are stopped and nothing is saved.
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
- [x] **B6** A 1-item poll fails (Telegram needs ≥ 2 options). → "I'm in on all of these" option (part of multi-poll, §8).
- [x] **B7** People in on everything can't vote. → Same option.
- [x] **F2** Item numbers → readable labels (owner request 2026-10-19). Scan captures each line's printed item number; the reader expands store shorthand ("KS" = Kirkland Signature) into a short label (brand, product, size); lines still unclear are looked up on the web by store + item number in the background (max 15 per receipt); every answer is cached per store + item number. Results only ever fill the "Use AI guess" suggestion — never the name or price automatically. Item numbers show small under the name.
- [x] **F1** Multiple polls per receipt (§8). Owner request, 2026-10-19. Live on the main bot 2026-10-19.
- [x] **B8** Votes accepted after the deadline and after lock. → Check status + `poll_closes_at` in `applyPollAnswer`.
- [x] **B9** Export CSV link gets a 401 in Telegram (no `initData` header). → Remove CSV export (button + endpoint); copying is enough.
- [x] **B10** Webhook secret is regenerated every boot. → Derive from the bot token when unset.
- [x] **B11** Fly may run 2 machines, which means 2 databases. → README deploys with `--ha=false` and checks `fly machines list` / `fly volumes list`. Tick after the first deploy is verified.

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
- [x] **B39** (P2) B32 still slips when SQLite reuses a freed item id (delete the highest line, add another): the id set looks unchanged, so a stale screen can overwrite the new line. → `receipt.items_version` bumped on every item write, sent back by the client; mismatch = 409 stale.
- [ ] **B40** (P3) Every toast shows a ✓, including errors ("✓ Someone else just changed this receipt"). → `toast(msg, kind)`, no check for errors.

### Found in live testing on the phone
- [x] **B41** (P0) Every current Telegram client was rejected at sign-in: `verifyInitData` dropped the `signature` field from the HMAC payload, but only `hash` is excluded (core.telegram.org/bots/webapps). Fixed in telegram.js; the test that encoded the wrong assumption is corrected. Needs the next adversarial pass.

### Found by the F1 adversarial test (verdict PASS) — fixes in progress
- [x] **B42** (P2) Two simultaneous "Post polls" on one receipt orphan a set of open Telegram polls; a failure after sending also leaves polls open. → Claim the receipt ('posting') before sending; stop everything sent on any failure.
- [x] **B43** (P3) A retraction (empty answer) still counts as "voted" for that poll. → Delete the voter row.
- [x] **B44** (P3) No cap on poll count; Telegram rate-limits groups (~20 msgs/min). → Max 15 polls (135 items).
- [x] **B45** (P2) `npm run dev` without DATABASE_PATH would open the live house DB. → Refuse to start off Fly without DATABASE_PATH.
- [x] **B46** (P2/P3) host.ps1 hardening: refuse unexpected keys in .env.production, only kill its own processes, health-check before reporting "up", exact tunnel-URL match. Rate-limit the rejected-sign-in log.
- [x] **B47** (P2) The group's "Split groceries now" button uses BotFather's Mini App URL, which goes stale on every laptop restart (new tunnel URL). → Owner updates BotFather after a restart until there's a stable host (Fly or a named tunnel).

### Found by the B42–B46 adversarial test (verdict FAIL) — fixes in progress
- [x] **B48** (P0) Locking while polls are still being sent gets undone: the send's commit overwrites 'confirmed' with 'polling'. Also affects the live version (window = the send, a few seconds). → 409 on lock/close during posting; guarded commit.
- [x] **B49** (P1) A vote on poll 1 while later polls are still sending is silently dropped. Also affects the live version. → Persist each poll as it's sent; accept votes while posting.
- [x] **B50** (P2) No timeout on Telegram calls, so a hung send can outlast the 120s sweep → double send, orphaned polls. → 15s timeout, 300s sweep cutoff, sweep/boot stop persisted polls.
- [x] **B51** (P2/P3) host.ps1: a malformed .env.production line is echoed (could print a pasted token); FLY_APP_NAME not cleared; health check fooled if another process owns :3100.

### Found by the B48–B51 adversarial test (verdict PASS)
- [ ] **B52** (P2) A poll send that takes >300s wall-clock (laptop sleeps mid-send) can be reverted while still running, then finish under another claim → Telegram polls out of step with the app (money still sums). → Unique claim token checked by every per-poll insert, the commit and the failure handler.

### Found by the pre-Fly adversarial test (verdict FAIL) — fixes in progress
- [x] **B53** (P1) A basic group upgraded to a supergroup gets a new chat id; the bot kept the dead id → polls fail, nobody can join, /start says "another group". → Follow migrate_to/from_chat_id.
- [x] **B54** (P2) A fresh database can be claimed by whichever group adds the bot first. → TELEGRAM_OWNER_ID: only the owner can set up or link the house.
- [x] **B55** (P3) Stranger groups re-adding the bot get the full greeting; raw group titles in logs; /start-linking mentions a button that isn't there.

### Found by the pre-push visual test (verdict FAIL) — fixes in progress
- [x] **B56** (P1, usability) Footers and the tab bar never stay pinned: `#app { overflow-x: hidden }` turns #app into a scroll container, which disables `position: sticky`. The lock button, poll footer and + FAB sit at the bottom of long pages. → `overflow-x: clip`.
- [x] **B57** (off-spec) Split hero "Owed back by 5 housemates: $115.00" sets money in Space Grotesk; all money must be JetBrains Mono.
- [ ] **D1** (owner decision) Handoff vs SPEC §9 conflicts: faint-grey amounts (settled receipt, grocer's own share, sub-lines), several accent elements on Review/Export/Onboarding, long item names truncated at 360px.

### Found by the pre-Fly re-gates (both PASS)
- [x] **B58** (polish) Receipts: the tab bar covers the bottom of the last card at rest. → Bottom padding on the list.
- [ ] **B59** (P3) TELEGRAM_OWNER_ID with stray spaces never matches (fails closed). → trim().
- [ ] **B60** (P3) After a group→supergroup migration, closing a pre-migration poll may leave it open in Telegram (money unaffected).

### Found by the F2 adversarial test (verdict PASS) — fixes in progress
- [x] **B61** (P2, cost) Rescans pay for the same lookups again (no in-flight dedupe; cap is per scan); failed lookups are never cached; no daily cap.
- [x] **B62** (P3) Saving from a screen older than freshly-arrived labels wipes them; item numbers hidden on flagged lines (SPEC F2 says always show); cache hits flag lines the OCR was sure about.
- [x] **B63** (P3) Labels with markup/URLs/long digit runs are accepted and cached forever; renaming a line doesn't correct the cache; lookups still write to locked receipts.
- [x] **B61b** (P3) The house is created on the bot-REMOVED event (my_chat_member member→left), and the greeting is attempted while kicked.

### Found by the F2 follow-up gate (verdict PASS) — fixes in progress
- [x] **B64** (P2, money; root of B39) SQLite reuses the highest item id after a delete, so an edit sheet left open across someone else's delete+add overwrites a DIFFERENT line (price included), and knownIds can't tell. → item.id AUTOINCREMENT (table-rebuild migration) so ids are never reused.
- [x] **B65** (P2, cost) The daily lookup cap counts cache rows, not calls: renames and failed retries bypass it. A typo in LOOKUP_DAILY_CAP removes it. → Count calls in their own table; validate the env value.
- [x] **B66** (P3) Editing a line someone else deleted says "Item updated"; a second receipt with a code already being looked up never gets the label; per-receipt cap resets on every restart.

### Found by the B64 gate (verdict PASS)
- [ ] **B67** (P2) The item rebuild runs foreign_key_check over the WHOLE DB and throws on any orphan, so one orphaned row anywhere = the app never boots (crash loop). Live DB checked clean (0 violations) before deploy. → Check only polled_item/opt_out, or roll back and keep running on the old schema.
- [ ] **B68** (P3) A line waiting on another receipt's lookup doesn't add to its own receipt's pending count, so that Review screen doesn't poll for the label.

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
| 2026-10-19 | Owner: polls are no longer capped. Long lists become several linked polls of ≤ 9 items (§8). |
| 2026-10-19 | Owner: build F2 (item-number lookups into readable labels). Web lookups cost a little per new product; cached forever per store + number. |
| 2026-10-19 | Owner: build F2 (item-number lookups into readable labels). Web lookups cost a little per new product; cached forever per store + number. |
| 2026-10-19 | Deployed to Fly: https://grosplit-blk42.fly.dev (app grosplit-blk42, region iad, one machine, one 1GB volume). The laptop host is retired; scripts/host.ps1 stays as a fallback. |
| 2026-10-19 | Only the owner (TELEGRAM_OWNER_ID, kept in .env.production / Fly secret) can set up or re-link the house. Fly starts with a fresh database (the laptop one has no house yet). |
| 2026-10-19 | Owner: the real house is the Telegram group "Watertown Family". The old test house is archived in backups/ (fresh grosplit.db). |
| 2026-10-19 | Owner: the house is in the USA (matters for product-code lookups). Duplicate lines stay as separate lines; no merging for now. |
| 2026-10-04 | DEV mode must be explicit (`DEV=1`) (§6). |
| 2026-10-04 | Owner: the house = the Telegram group. Leaving the group = leaving the house (§6). |
| 2026-10-04 | Owner: anyone in the house may edit receipt lines, for now. |
| 2026-10-04 | Owner: one household per deployment, for now. |
| 2026-10-04 | Owner: no CSV export. Copying amounts into Tricount is enough. |
| 2026-10-04 | Owner: the receipt's creator or grocer can change the payer or delete the receipt while it's in review. |
| 2026-10-04 | Owner: two bots. Laptop = test bot (@gro_split_test_bot, token in `.env`, `./test.db`). Production = real bot (@gro_split_bot, token kept in gitignored `.env.production`, set as a Fly secret). |
| 2026-10-04 | Owner: OK that a receipt's creator can make themselves the payer and lock (anyone can already create a receipt naming themselves as payer). |
| 2026-10-04 | Owner: code lives at https://github.com/benguy6/grosplit — push there after the gates pass. |
| 2026-10-13 | Owner: no card for Fly yet. Until a real host is sorted, the house runs on the owner's laptop: real bot + ./grosplit.db on port 3100 via scripts/host.ps1 and a Cloudflare quick tunnel (test bot stays on 3000). Laptop must be on and awake. |
| 2026-10-04 | Owner: remove the "Auto-flag staples" and "Round to nearest cent" switches. Rounding always happens; staples can return if people game the poll. |
