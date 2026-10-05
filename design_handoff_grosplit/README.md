# Handoff: GroSplit

## Overview

GroSplit is a mobile app for a 6-person household that splits grocery bills. One housemate shops and pays; the app reads their receipt (AI OCR or manual entry), lets them review and correct every line, optionally runs a Telegram poll so people can opt out of specific items, computes each person's exact share, and hands off per-person totals that get entered into Tricount.

Scope is deliberately narrow: **GroSplit is a calculator and receipt reader, not a payments app.** It never moves money, has no in-app chat, and does not replace Tricount — it produces the numbers you type into Tricount. The poll lives entirely in Telegram; GroSplit's bot posts it and reads results back.

Household: 6 people, currency USD, tax read off the receipt.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes that show intended look and behavior. They are not production code to copy directly.

- `GroSplit App.dc.html` — all 11 screens as an interactive prototype
- `GroSplit Design System.dc.html` — tokens, components, and rules
- `ios-frame.jsx`, `support.js` — prototype scaffolding only (device bezel + a small streaming-template runtime). **Both are irrelevant to the real app. Do not port them.**

The task is to **recreate these designs in the target codebase's environment** using its established patterns and libraries. If no codebase exists yet (as of this handoff, `benguy6/grosplit` is empty except a README), pick the appropriate stack. Given the design is iOS-first and the AI receipt read needs a server-side model call plus a Telegram bot, a reasonable choice is:

- **React Native + Expo** (or SwiftUI if iOS-only is acceptable)
- A small backend for: receipt OCR/parsing, the Telegram bot (posts polls, receives `poll_answer` updates), and receipt persistence
- Any SQL store; the data model here is tiny

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, copy, and interaction states are all final. Recreate the UI pixel-accurately using the target codebase's libraries. Where a value isn't stated below, read it off the prototype's inline styles — every style in `GroSplit App.dc.html` is inline and literal.

Two caveats:
- Two prototype screens fake a real input surface for demo purposes: the **Scan** camera viewfinder is a CSS pattern (needs a real camera), and the **Manual entry** screen's name field uses tap-to-fill suggestion chips plus ± price steppers instead of a keyboard. In production both should be ordinary native inputs; the layout and styling still apply.
- Poll voting is simulated on a timer. In production it's driven by Telegram webhook events.

---

## Design Tokens

### Color

| Token | Hex | Use |
| --- | --- | --- |
| Paper | `#EFEBE3` | App background |
| Card | `#FFFDF8` | Receipt + card surfaces |
| Ink | `#1C1A17` | Primary text, dark panels |
| Ink 60 | `#5C574F` | Secondary text |
| Ink 40 | `#9A9389` | Meta, mono labels, hints |
| Ink 25 | `#B5AEA2` | Faintest mono meta |
| Accent | `#E8552D` | One per screen: primary action or the hero number |
| Accent hover | `#C4401C` | Primary button hover |
| Accent disabled | `#F1C3B2` | Disabled primary |
| Accent soft | `#FDEBE4` | Selected rows, focus ring, destructive-confirm bg |
| Accent deep | `#8F3418` | Text on accent-soft |
| Sage | `#3B7A57` | Confirmed / in / toggle-on |
| Sage hover | `#2F6246` | |
| Sage muted | `#C4CFC6` | Lock button when user isn't the grocer |
| Sage soft | `#E7F1EA` / text `#2F6246` | "SETTLED" badge |
| Amber | `#D9A400` | Needs review (left edge) |
| Amber soft | `#FDF3D6`, border `#E8CE7A`, text `#8A6A00` / `#6E5500` | AI-unsure states, warning banners |
| Danger | `#B03A1B`, hover `#963014`, border `#E7C3B5` | Destructive |
| Line | `#E3DDD2` | Hairline borders |
| Line soft | `#F2EEE6` | Internal dividers |
| Dash | `#C9C1B4` | Dashed rules, torn edges, double rules |
| Dot | `#D5CEC2` | Dotted leader lines |
| Fill hover | `#F4F0E8` / `#E4DFD5` | Hover on card / on paper |
| Toast | bg `#1C1A17`, text `#FFFDF8`, check `#7FC49B` | |

**Accent rule:** one accent element per screen — the primary action *or* the number the user came for, never both. Opt-out state is ink-40 + strikethrough, never red.

**Avatar palette** (assigned on join, never reshuffled; user-editable in House):
`#E8552D` `#3B7A57` `#5C574F` `#D9A400` `#8A6A4B` `#7A8B99` `#B0473F` `#4F6B8A`

Defaults: Ben `#E8552D`, Aisha `#3B7A57`, Mira `#5C574F`, Kai `#D9A400`, Théo `#8A6A4B`, Sam `#7A8B99`.

### Typography

Two families, loaded from Google Fonts:
- **Space Grotesk** (400/500/600/700) — all UI voice
- **JetBrains Mono** (400/500/700) — all money, all metadata, all receipt content

| Role | Spec |
| --- | --- |
| Display | Space Grotesk 700, 30–34px, line-height 1.1–1.15, letter-spacing −0.025em |
| Title | Space Grotesk 600, 18–22px, letter-spacing −0.01em |
| Body | Space Grotesk 400, 15–16px / 1.5 |
| Label | Space Grotesk 500, 12–13px |
| Button | Space Grotesk 600, 16px |
| Money | JetBrains Mono 500–700, 16–40px, **`font-variant-numeric: tabular-nums`** |
| Meta | JetBrains Mono 400–500, 10–11.5px, uppercase, letter-spacing 0.04–0.08em |
| Receipt store name | JetBrains Mono 700, 14–15px, uppercase, letter-spacing 0.14–0.18em, centered |
| Flow-strip step | JetBrains Mono 500, 8.5px, letter-spacing 0.06em, uppercase |

**Rule: every currency figure is JetBrains Mono with `tabular-nums` so decimals align down a column. Never set money in Space Grotesk.** Never set a receipt line item in Space Grotesk either.

### Spacing & geometry

4pt base: 4 / 8 / 12 / 16 / 24 / 32.
Screen gutter 20 · card padding 16–18 · list row min-height 56–60 · stacked card gap 12 · primary button height 50–52 · min hit target 44.

**Radius is meaningful here:**
- Receipt surfaces: **radius 0**, with torn top and bottom edges. Never a rounded card.
- Interactive chrome: 12–14 (buttons, inputs, rows), 22 (bottom sheets, top corners only), 999 (chips, avatars, back buttons, FAB), 8 (checkbox squares), 3–4 (nav rail rows).

Shadow is near-absent — depth comes from the hairline. `0 1px 2px rgba(28,26,23,.05)`; only three exceptions: FAB `0 4px 14px rgba(232,85,45,.32)`, bottom sheet `0 -8px 30px rgba(28,26,23,.18)`, toast `0 8px 24px rgba(28,26,23,.22)`.

### Receipt rules & edges

| Rule | CSS | Meaning |
| --- | --- | --- |
| Dashed | `1px dashed #D5CEC2` | Section break |
| Dotted | `1px dotted #D5CEC2` | Leader line between label and price |
| Double | `3px double #C9C1B4` | Always directly under a total |
| Torn edge | see below | Top and bottom of every receipt surface |

Torn edge, 14px teeth (9px tall; 16px/11px for the taller sheet variant):

```css
/* bottom-of-element teeth (used at the TOP of a receipt) */
background:
  linear-gradient(-45deg, #FFFDF8 7px, transparent 0) 0 100%/14px 14px repeat-x,
  linear-gradient( 45deg, #FFFDF8 7px, transparent 0) 0 100%/14px 14px repeat-x;

/* top-of-element teeth (used at the BOTTOM of a receipt) */
background:
  linear-gradient(-45deg, transparent 7px, #FFFDF8 0) 0 0/14px 14px repeat-x,
  linear-gradient( 45deg, transparent 7px, #FFFDF8 0) 0 0/14px 14px repeat-x;
```

**Never** fake thermal-print artifacts — no faded rows, no skew/rotation, no barcode graphics. The receipt is a layout metaphor, not a costume.

### Iconography

Outline only, 1.75px stroke, 24px box, round caps and joins. Geometric primitives — square, circle, chevron, plus, check. No filled glyphs, no duotone. Money never gets an icon; the `$` is the icon. The prototype uses text glyphs (`←` `+` `✓` `×` `↺` `⏳`) and one inline SVG trash can:

```html
<svg width="17" height="19" viewBox="0 0 17 19" fill="none">
  <path d="M2.5 5h12M6.5 2.5h4M4 5l.9 11.2a1 1 0 001 .8h5.2a1 1 0 001-.8L14 5M7 8.5v5.5M10 8.5v5.5"
        stroke="#B03A1B" stroke-width="1.6" stroke-linecap="round"/>
</svg>
```

### Motion

| What | Spec |
| --- | --- |
| Screen push | 280ms `cubic-bezier(.32,.72,0,1)` |
| Bottom sheet in | 320–340ms `cubic-bezier(.32,.72,0,1)`, `translateY(100%) → 0` |
| Scrim fade | 180ms ease |
| Row / list item in | 220–300ms ease, `opacity 0 + translateY(8px) → none` |
| Row tap | 120ms, `scale(0.98)` |
| Button hover | 120ms background |
| Toggle | 150ms background |
| Scan line | 1.1s `cubic-bezier(.4,0,.6,1)` infinite alternate, `top: 6% → 88%` |
| Recalculated numbers | count up over 600ms — the app's signature tick |
| Poll vote landing | 8px slide-in, no bounce |

Nothing loops, nothing pulses. Toast auto-dismisses at 2200ms.

### Voice

Housemate, not bank. Short, warm, a little dry. "Kai's out on the protein powder." Never "transaction", "settlement", or "participant". Amounts are always stated plainly and never softened — the whole point is that nobody has to ask twice.

---

## Data Model

```
Household   { id, name: "Blk 42 · #05-11", telegramChatId, pollWindowHours: 4,
              autoFlagStaples: true, roundToCent: true }
Member      { id, name, initial, avatarColor, telegramHandle, telegramUserId }
Receipt     { id, householdId, store, createdAt, grocerId,
              taxAmount, taxEnabled, taxMode: 'pro'|'even',
              status: 'review'|'polling'|'confirmed',
              polledItemIds: [], telegramPollId }
Item        { id, receiptId, name, price, aiFlagged: bool, aiGuess: string|null }
OptOut      { receiptId, itemId, memberId }
```

**`grocerId` is per receipt, not a role on the member.** The signed-in user is "you"; the grocer is whoever paid for *this* receipt. Only the grocer can confirm/lock, and the grocer absorbs the rounding remainder. History shows shops paid for by Mira, Aisha, Kai and Théo, so the app must handle receipts the current user didn't pay for (see Confirm Split).

### Split algorithm — implement exactly

```
subtotal = Σ item.price
tax      = taxEnabled ? round2(subtotal × TAX_RATE) : 0     // prototype TAX_RATE = 0.09
total    = round2(subtotal + tax)
totalCents = round(total × 100)

// 1. per-item, only polled items can have opt-outs
for each item:
    outs = taxEnabled…  no —  outs = optOuts(item) if receipt.polled && item ∈ polledItemIds else []
    participants = members − outs                    // never empty; non-voters stay IN
    each participant += item.price / participants.length

// 2. tax
if tax > 0:
    for each member:
        memberTax = taxMode == 'even' ? tax / 6
                                      : (member.amt / subtotal) × tax     // pro-rata
        member.tax = round2(memberTax)
        member.amt += memberTax                       // unrounded, for accuracy

// 3. round to cents; the GROCER absorbs the remainder so shares always sum to total
owedCents = 0
for each member ≠ grocer:
    c = round(member.amt × 100); member.amt = c / 100; owedCents += c
grocer.amt = (totalCents − owedCents) / 100
```

Two invariants worth a unit test: **the sum of all shares always equals the total exactly**, and **an item with zero participants can never occur** (a member who never votes is IN, and the grocer cannot opt out).

Even-split display value: `round(totalCents / 6) / 100`.

---

## Screens

11 screens, one component each. The prototype keeps everything in one state machine with a `screen` string; a real app uses a stack navigator. The left-hand nav rail in the prototype is a demo affordance — **do not ship it.**

### 1. Onboarding — household setup

Paper bg, padding `78px 22px 40px`, column.

- 48px accent square, radius 15, white "G" 700/24px
- Display: "Who's in the house?"
- Body ink-60: "Everyone splits everything by default. The Telegram poll is how people get out of things."
- **Household** field — label 12px ink-60, focused input: height 48, radius 12, `1.5px solid #E8552D`, bg card, `box-shadow: 0 0 0 4px #FDEBE4`, value "Blk 42 · #05-11"
- **Members** — label row with "6 OF 6" mono right. Card, radius 16, one 56px row per member: 32px avatar circle, name 500/15px, tag mono-11 ink-40 right ("YOU" on the current user, blank on others). Divider `1px solid #F2EEE6`.
- **Telegram** row: 34px `TG` tile, "Telegram group linked", mono `@BLK42FOOD · BOT ACTIVE`, sage toggle on
- Spacer, then primary "Start splitting" → Receipts

### 2. Receipts (home)

The main screen. Padding-top 64.

- Header: mono-11 ink-40 "BLK 42 · #05-11" over display "Receipts"; right side overlapping 30px avatars (−9px margin) + "+3" neutral circle
- **Active receipt — the hero component.** A real receipt: torn top edge, card body `padding: 4px 18px 18px`, torn bottom edge, `filter: drop-shadow(0 1px 2px rgba(28,26,23,.07))`, tappable.
  - Centered header: store name mono-700/15 uppercase 0.14em tracked, then mono-10.5 `TODAY 19:42 · 12 ITEMS · BY BEN`, dashed rule under
  - `SUBTOTAL` and `TAX` rows: mono-11.5 ink-60, label left, **dotted leader `flex:1`**, value right
  - Total block: dashed rule above, `3px double #C9C1B4` below, `TOTAL PAID` mono-12 0.1em left vs mono-700/26 tabular right
  - Footer: status hint mono-11 ink-60 (max-width 180) + square status badge mono-10.5
  - Status: `NEEDS REVIEW` accent-soft / `POLL OPEN` amber-soft / `LOCKED` sage-soft. Tap routes to review / live / export respectively.
- **Settled receipt** — same anatomy, condensed, `opacity: .62`, "SETTLED · IN TRICOUNT" + muted total
- **THIS MONTH** — two cards: `$487.15` "across 7 shops", `$81.19` "avg. per person"
- **Tab bar** (sticky bottom, card bg, `1px solid #E3DDD2` top, padding `10px 30px 30px`): Receipts tab (2px square, ink when active) · 56px accent FAB, `margin-top: -26px`, 30px "+" · House tab (2px circle). Active ink, inactive ink-40, **no accent in the bar** so the FAB stays loudest. The bar persists on Receipts and House only.

### 3. New receipt sheet (FAB → this, before the camera)

A receipt pulling up from the bottom — this is where the store name and payer come from, so the rest of the flow has real data.

Scrim `rgba(28,26,23,.38)` fading in 180ms; sheet `animation: gsUp 340ms cubic-bezier(.32,.72,0,1)`.

- Torn top edge, 16px teeth / 11px tall
- Card body `padding: 16px 22px 34px`
- Centered `NEW RECEIPT` mono-700/14 0.18em, `29 AUG 2026 · 19:42` mono-10.5 ink-40, dashed rule
- `WHERE DID YOU SHOP?` mono-10.5 0.08em → focused text input (accent border + `0 0 0 4px #FDEBE4` ring), placeholder "Store name"
- Suggestion chips (pill, paper bg, hairline): **Trader Joe's · Whole Foods · Safeway · Costco · Kroger · Target**
- Dashed rule → `WHO PAID?` → 6 member pills (22px avatar + name, "You" for self); selected gets accent-soft bg + accent border. Defaults to self.
- Dotted rule → `ITEMS ──── PENDING SCAN`
- Primary: "Line up the receipt →" (accent) / "Name the shop first" (disabled `#F1C3B2`) when the field is empty → Scan

### 4. Scan receipt

Ink bg `#1C1A17`, padding-top 64.

- Header: translucent-white 38px back circle, store name centered 500/13 white
- Viewfinder: `margin: 20px`, `flex: 1`, radius 22, bg `#2A2622`, overflow hidden
  - **Production: a live camera feed.** Prototype approximates it with `repeating-linear-gradient(180deg,#37322D 0 3px,#2E2A25 3px 22px)`
  - Dashed guide inset 26/44, `2px dashed rgba(255,255,255,.28)`, radius 14
  - While scanning: 3px accent line, `box-shadow: 0 0 22px 5px rgba(232,85,45,.55)`, `gsScan` 1.1s alternate
  - Centered label mono-12 0.08em `rgba(255,255,255,.65)`: "LINE UP THE RECEIPT" → "READING RECEIPT…"; hint below `rgba(255,255,255,.42)`: "Flat surface, all lines visible. Long receipts are fine — just keep scrolling." → "Finding items, prices and tax"
- Controls: "Enter manually" pill · 70px shutter (`3px solid rgba(255,255,255,.85)` ring around a 56px accent disc) · "Upload" pill (dimmed)
- Shutter → 1900ms scan → Line review. Real behavior: capture → upload → OCR + LLM parse → items with `aiFlagged` / `aiGuess` on low confidence.

### 5. Line review

Where the AI gets corrected. Sticky header, padding `60px 20px 10px`, `1px solid #E3DDD2` bottom.

- **Flow strip** (top of header): 5 equal steps `REVIEW · POLL · VOTES · SPLIT · EXPORT`, each a 3px bar + 8.5px mono label, `gap: 5px`. Current accent, completed ink / ink-60, upcoming `#DDD6CA` / ink-25. **Every step is tappable** for backtracking; unreachable steps toast "Finish the split first". Repeated identically on Poll, Votes, Split and Export.
- Back circle (→ **Receipts**, never step-by-step back through the flow), "Review 12 items" + `TRADER JOE'S · SCANNED 12S AGO`, running total mono-700/20 right
- Amber banner when AI is unsure: `!` + "2 names the AI wasn't sure about" (singular "1 name…") + underlined "Fix all"
- **Item rows** — the workhorse. Radius 12, card bg, hairline, **`border-left: 3px solid`** carrying status, `gsIn` on mount:
  - Normal: left edge `#E3DDD2`, 26px accent checkbox with white ✓, name 500/15, sub mono-11 ink-40 `SPLIT 6 WAYS · $0.72 EA`
  - AI-unsure: left edge amber, `#FDF3D6` box with `?`, sub `#8A6A00` `AI UNSURE · TAP TO FIX THE NAME`
  - Price mono-500/16 tabular, then a small **Edit** pill (paper bg, hairline, mono-11) — every row is editable, not just flagged ones
  - Row tap = Edit tap = open the edit sheet
- Dashed "+ Add an item" row → Manual entry
- **Totals card**: `Subtotal` → dividing rule → **"Split the tax too"** row (title, mono-10.5 note `READ OFF RECEIPT · GST 9%` / `NOT SPLIT · GROCER ABSORBS IT`, amount, sage/neutral toggle) → when on, a segmented `By share | 6 ways` (radius 11 in a paper track, active pill card bg) plus a note ("Tax follows what each person actually owes." / "$1.90 of tax each, flat.") → dashed + double rule → `Total`
- Sticky footer: "Everyone in on everything · $23.00 each", primary **"TG Send poll to @blk42food"** → Poll composer, secondary text button "Skip the poll — split all 6 ways" → Split

### 6. Edit item sheet

Bottom sheet, paper bg, top radius 22, `padding: 18px 20px 34px`, 38×4 grab handle, `gsIn`. Tapping the scrim cancels.

- "Edit item" + mono-11 right meta (`AI WASN'T SURE` / `FROM RECEIPT`)
- **Name** — accent-focused input, `gsIn`; when an AI guess exists, an amber pill below: "Use AI guess: Spicy chicken sandwich" fills the field
- **Price** — `$` prefix mono-15 ink-40 + mono-19 tabular input (strip non-numeric), plus 50px `−` / `+` steppers at ±0.10
- Actions: 52px trash button (transparent, `1px solid #E7C3B5`, the SVG above) + accent "Save" (flex 1)
- **Trash → inline confirmation** replacing the action row: accent-soft panel, `1px solid #E7C3B5`, "Remove Protein powder?" `#8F3418` + "It comes off the receipt and everyone's share drops by $5.43." `#A0543A`, then "Keep it" (card bg) / "Remove" (`#B03A1B`). Save toasts "Item updated"; remove toasts "Item removed".

### 7. Manual entry

Paper, `60px 20px 40px`. Back → Line review. "Add item".

- Name field (accent-focused) — **production: a normal text input**; the prototype fills it from chips: Kimchi 500g · Rice 5kg · Chicken thigh · Trash bags · Sriracha
- Price field, `$` prefix + mono-19 tabular right
- Six ± stepper buttons `−1.00 −0.10 −0.01 +0.01 +0.10 +1.00` (prototype stand-in for a numeric keypad)
- Primary "Add to receipt" → appends and returns to review, toast "<name> added"

### 8. Poll composer

Optional by design. Everyone pays for everything unless a poll says otherwise.

- Header: flow strip, back (→ Receipts), "Anything worth a poll?" + `OPTIONAL · 2 PICKED`, and a **SELECT ALL / CLEAR ALL** pill (mono-10, toggles by comparing selection length to item count)
- Explainer: "Default is simple: everyone pays for everything. Only pick the items where someone might reasonably want out — those go into one Telegram poll."
- Selectable rows: unselected card bg + hairline + empty 26px box; selected accent-soft bg, accent border, accent box with ✓
- **TELEGRAM PREVIEW** — a chat bubble (radius 16 with `border-top-left-radius: 6px`): "🛒 Trader Joe's · $137.97 / Tick anything you're NOT in on. Closes in 4h." then one 10px-radius `#F4F0E8` option row per picked item with a hollow radio, then `MULTI-SELECT · ANONYMOUS: OFF`
- Footer: primary "Post poll to @blk42food" (disabled `#F1C3B2` "Pick at least one item" when nothing is picked) → Poll monitor; text button "Skip — split all 6 ways" → Split

Real behavior: `sendPoll` with `allows_multiple_answers: true`, `is_anonymous: false`, one option per picked item; persist `telegramPollId` + option→item mapping.

### 9. Poll monitor (live)

- Header: flow strip, back, "Poll is live" + `3 OF 5 VOTED · CLOSES IN 3H 52M`
- **Voter strip**: 5 equal tiles (the grocer is excluded — they don't vote). Voted: card bg, colored 30px avatar, mono-10 `2 OUT` / `ALL IN`. Pending: `#F1EDE5`, `#C9C1B4` avatar, `…`. Each lands with `gsIn`.
- `OPT-OUTS COMING IN` → one card per polled item: name + price on top; below, overlapping 24px avatars of the opted-out (−6px, `2px solid #FFFDF8`, `gsIn`), note mono-11.5 ("Aisha, Kai, Sam out" accent-deep / "everyone still in" ink-40), and recomputed `$X.XX EA` right
- Footer: note "Waiting on 2 of 5. Anyone who never votes stays in." → "Everyone voted — opening the split…"; button "Close poll early · 3/5 in" (ink) → "See the split" (accent). **When all 5 have voted the app auto-advances to Split after ~1.5s** — the grocer shouldn't have to babysit it.

Real behavior: subscribe to `poll_answer` webhooks, upsert OptOut rows, live-update. Auto-close at `pollWindowHours`.

### 10. The split (grocer confirms)

- Header: flow strip, back → **Receipts**, "The split" + `5 VOTED · 2 ITEMS POLLED` (or `NO POLL · EVERYONE IN ON ALL 12`)
- **Hero panel**: ink bg, radius 18, padding 20 — `YOU PAID` / `MIRA PAID` mono-11 0.06em ink-40, then **mono-700/40, letter-spacing −0.04em, `#FFFDF8`** total, "Owed back by 5 housemates: $114.98" `#B7B0A5`, then a `rgba(255,253,248,.14)` rule and mono-11 `SUBTOTAL $126.58 · TAX $11.39 · BY SHARE`
- **Receipt-styled breakdown** (card bg, square): centered `WHO OWES WHAT` + dashed rule, then per member — 22px avatar, `AISHA` / `BEN (YOU)` mono-13.5, a `GROCER` chip on whoever paid, **dotted leader**, amount mono-600/17 tabular (grocer's own share is ink-40). Sub-line indented 30px, mono-10 ink-25: `11 OF 12 ITEMS · +$2.06 TAX`, or `PAID $137.97 · KEEPS THE ROUNDING` for the grocer. Footer: dashed + double rule, `SUM OF SHARES` = total.
- Footer: `lockNote` — "Only you can lock this — you did the shopping." / "Only Mira can lock this — they did the shopping."
- **Lock button, grocer-gated**: grocer sees sage "✓ Confirm & lock split"; everyone else sees muted `#C4CFC6` "⏳ Waiting on Mira to confirm" and tapping toasts "Only the grocer can lock the split". Confirming → Export + toast "Split locked — nobody can change it now".

### 11. Tricount export

The handoff. Header: flow strip, back → Receipts, "Put it in Tricount" + `LOCKED · TRADER JOE'S · TODAY`.

- **TRICOUNT ENTRY** card — the fields to retype, in Tricount's own order: Title `Trader Joe's · 29 Aug` · Paid by `Ben` · Amount `$137.97` (mono) · Split `Unequally · 6 people`
- `TAP A ROW TO COPY THE NUMBER` → 5 rows (grocer excluded), each 30px avatar + name + amount mono-600/17 + `COPY` mono-11 ink-40; tap copies and toasts "Copied $23.77 — Aisha"
- "Copy all 5" (card bg, `1.5px solid #1C1A17`) + "Export CSV" (paper fill)
- Primary "Done — back to receipts"

### 12. History (reached from House)

Back circle + "History". Six rows: shopper avatar, store, mono meta `25 AUG · 9 ITEMS`, total mono-600/16 with `$10.20 EA` mono-10 ink-40 beneath. Then a **WHO SHOPS MOST** card: name (56px) + 9px-tall rounded bar (paper track, member-colored fill, % width) + count.

### 13. House / members

A tab root — **no back button**, tab bar visible.

- Title "Blk 42 · #05-11" + "History" pill
- Member card, 58px rows: avatar (tappable), name, mono handle `@AISHAK`, tag, and a **COLOR** pill (12px dot + mono-9.5 label). Tapping either opens an inline 8-swatch palette row (28px circles, selected ringed via `box-shadow: 0 0 0 2px #FFFDF8, 0 0 0 3.5px #1C1A17`, `gsIn`); picking one recolors that member everywhere. Last row: "+ Invite a housemate".
- Settings card: **Poll window** ("How long people get to opt out") with a `4H` pill · **Auto-flag staples** ("Milk, soap, towels never enter the poll") sage toggle · **Round to nearest cent** ("Remainder goes to the grocer") sage toggle
- Footer mono ink-40: `GROSPLIT 0.1 · TELEGRAM BOT CONNECTED`
- Tab bar at the bottom (House active)

### Toast

`position: absolute`, left/right 20, `bottom: 104` (clears the tab bar), z 80. Ink bg, radius 14, `#7FC49B` ✓ + 500/14 `#FFFDF8`, `gsIn` 220ms, auto-dismiss 2200ms.

---

## Navigation & Interaction Rules

1. **Back always exits to Receipts.** No screen walks the user backwards through the whole flow. The flow strip is how you go back a step deliberately.
2. **The flow strip is navigation**, not decoration: any reachable step is tappable; unreachable ones toast.
3. **The tab bar exists only on Receipts and House** (the two roots). Flow screens are full-screen with their own footers.
4. Timers must be cleared on unmount, and re-entering the poll monitor must not duplicate votes (guard by voter id).
5. The FAB never opens the camera directly — always the new-receipt sheet first, so store and payer are known.

## State

```
screen, store, grocer, items[], selected[] (polled item ids),
scanning, sent, votes[], closed, confirmed,
taxOn, taxMode, colors{memberId→hex},
newSheet, storeDraft, grocerDraft,
editId, editName, editPrice, editGuess, confirmDelete,
draftName, draftPrice, toast
```

In production: receipts/items/opt-outs are server state (React Query / SWR); only sheet drafts, the current screen, and the toast are local.

## Assets

None. No images, no icon font, no illustrations — every visual is CSS or an inline SVG path. Fonts come from Google Fonts (Space Grotesk, JetBrains Mono); bundle them locally in a native app.

## Suggested build order

1. Design tokens + receipt primitives (torn edge, dotted leader row, total block) — everything else composes from these
2. Data model + the split algorithm, with tests on the two invariants
3. Receipts → new-receipt sheet → manual entry → line review → edit sheet (a complete, useful app without any AI or Telegram)
4. Receipt OCR/parse with confidence flags
5. Telegram bot: post poll, receive `poll_answer`, live monitor
6. Split + grocer lock + export/CSV

## Files in this bundle

| File | What it is |
| --- | --- |
| `GroSplit App.dc.html` | All 11 screens, interactive. Open in a browser and click through. Every style is inline and literal — this is the source of truth for exact values. |
| `GroSplit Design System.dc.html` | Tokens, component states, receipt anatomy, and the rules above, laid out visually. |
| `ios-frame.jsx`, `support.js` | Prototype scaffolding (device bezel, template runtime). **Ignore — do not port.** |

Screenshots aren't included; say the word and I'll add them.
