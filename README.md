# GroSplit

Splits grocery bills for one 6-person household. One housemate shops and pays; the app reads
the receipt, lets them correct every line, optionally runs a Telegram poll so people can opt out
of specific items, computes exact shares, and hands off per-person totals to type into Tricount.

**It is a calculator and a receipt reader.** It never moves money and it does not replace
Tricount. The poll lives entirely in Telegram.

Built as a **Telegram Mini App** — the full UI in a webview, launched from the bot's menu
button. The bot itself is invisible plumbing: it posts the poll and catches votes. Nobody types
commands at it.

## Running it locally

```bash
npm run demo       # http://localhost:3000 — fake household, no Telegram, ./demo.db
npm run dev        # the TEST bot from .env, ./test.db, restarts on file changes
npm test           # no network needed
node scripts/shots.js   # screenshot every screen at phone size → .shots/
```

**Demo mode** (`DEV=1`, set by `npm run demo`) skips Telegram sign-in, makes you the first
member, and seeds a demo household (Blk 42, six housemates, the 12-line Trader Joe's receipt
totalling $137.97). It must be asked for: with no bot token and no `DEV=1` the server refuses
to start, and `DEV=1` is refused on Fly.

Deep links jump straight to a screen: `#review/1`, `#confirm/1`, `#house`.

## Two bots

| Where | Bot | Token lives in | Database | Gets updates by |
| --- | --- | --- | --- | --- |
| Laptop | a test bot | `.env` | `./test.db` | long-polling |
| Production (Fly) | the real bot | Fly secret (kept locally in gitignored `.env.production`) | `/data/grosplit.db` | webhook |

Telegram delivers a bot's updates to one place only, so the two never share a bot. As a
safety net, off Fly the server refuses to long-poll a bot that already has a webhook.

## Configuration

Copy `.env.example` to `.env` (laptop) and fill it in:

| Variable | Where from |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | @BotFather `/newbot` — the **test** bot on the laptop. Also the key that verifies Mini App sign-ins |
| `OPENAI_API_KEY` | platform.openai.com — one vision call per receipt |

`WEBHOOK_SECRET` is derived from the token if unset. `PUBLIC_URL` defaults to
`https://<app>.fly.dev` on Fly. `OPENAI_MODEL` overrides the vision model without a code change.
The household's group is learned automatically when the bot is added to it.

## Setting up a bot

1. `/newbot` in @BotFather
2. In BotFather, set the Mini App URL (`/myapps` → your bot → Edit Web App URL) to the HTTPS
   address serving the app — `https://<app>.fly.dev` for the real bot. Telegram requires HTTPS,
   so the test bot on a laptop needs a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`).
3. Add the bot to the group. It greets the group with the button that opens the app.
   Privacy mode can stay on.
4. Everyone taps the button once. Only people in the group can join.

## Deploying

```bash
fly auth login
fly launch --no-deploy --ha=false       # app name is in fly.toml
fly volumes create grosplit_data --size 1
# Secrets come from the gitignored .env.production (real bot token + OPENAI_API_KEY=...),
# piped in so they never land in shell history:
grep '^[A-Z_]*=' .env.production | fly secrets import
#   PowerShell: Select-String '^[A-Z_]+=' .env.production | % Line | fly secrets import
fly deploy --ha=false
fly machines list                       # must show exactly ONE machine (SQLite lives on its volume)
fly volumes list                        # must show exactly ONE volume
```

Scale-to-zero is on (`auto_stop_machines = 'stop'`): the webhook and the Mini App are plain
HTTP requests, which wake a stopped machine. Polls close lazily — an expired poll is closed on
the next request or vote — so nothing depends on a background timer.

## Layout

| File | What |
| --- | --- |
| `split.js` | The split algorithm. Pure, no I/O. The normative piece |
| `db.js` | SQLite schema and queries via `node:sqlite` |
| `telegram.js` | `initData` verification (trust boundary) and Bot API calls |
| `ocr.js` | One OpenAI vision call with a strict JSON schema |
| `server.js` | Routing, auth, API, webhook / long-poll, poll lifecycle |
| `seed.js` | Demo data, DEV mode only |
| `public/` | The Mini App — `styles.css` (tokens + receipt primitives), `app.js` (11 screens) |
| `scripts/` | `shots.js` (phone-size screenshots), `phone.ps1` (capture a mirrored phone) |
| `SPEC.md` | **Source of truth**: how the app must work, rules, backlog, decisions |
| `CLAUDE.md` | How the AI team works on this repo |

**Zero runtime dependencies.** `node:sqlite`, `node:test` and `--env-file` replace a driver, a
test framework and dotenv. Node 22.13+ required; developed on 24.

## The split algorithm

All money is integer cents. `priceCents` is the **line total** as printed; `quantity` is display
metadata, never a multiplier. Coupons and deposits are items with a negative price.

```
per item: participants = members − opt-outs (polled items only; non-voters stay IN)
          each participant += price / participants.length
tax:      pro-rata (member.amt / subtotal × tax) or flat (tax / n)
round:    round the non-grocers to cents; grocer.amt = totalCents − owedCents
```

Two invariants, both tested across 2160 randomised cases and 192 exhaustive combinations:

- **the sum of all shares equals the total exactly** — guaranteed by construction, since the
  grocer absorbs the rounding remainder
- **an item can never have zero participants** — the grocer cannot opt out of their own
  receipt, and the share function floors to the full household regardless

## Deviations from the design handoff

Deliberate, and worth knowing about:

1. **Tax is read off the receipt**, not computed at a fixed 9%. The prototype hardcoded
   `TAX_RATE = 0.09` while its own copy said "READ OFF RECEIPT"; OCR fills `taxAmount` and the
   review screen allows a manual override.
2. **Poll selection is capped at 10** — Telegram's `sendPoll` limit. The prototype's SELECT ALL
   over 12 items would have failed at the API. Enforced on both client and server.
3. **`quantity` and negative prices** were added to `Item` so real receipts (coupons, deposits,
   weighted goods) can be represented at all.
4. **Items lock while a poll is live.** The flow strip allows backtracking to Review; without
   this, deleting a polled item orphans the live Telegram poll.
5. **`--ink-meta` replaces ink-25 for text.** `#B5AEA2` on card is ~2:1 contrast and the design
   used it for a line carrying real money. Ink-25 is kept for decoration only.
6. **The nav rail is gone**, as the handoff instructed. Deep-link hashes replace it.

## Still to do

See the backlog in [SPEC.md](SPEC.md) §11.
