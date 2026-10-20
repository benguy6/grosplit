'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const d = require('./db.js');
const tg = require('./telegram.js');
const { evenSplitCents } = require('./split.js');
const { parseReceipt } = require('./ocr.js');
const seed = require('./seed.js');
const lookup = require('./lookup.js');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const MAX_UPLOAD = 12 * 1024 * 1024; // trust boundary: cap receipt photos

// DEV skips initData and seeds a browsable demo household. It must be asked for
// explicitly: a missing bot token must never silently turn authentication off.
const DEV = process.env.DEV === '1';

function die(msg) {
  if (require.main === module) {
    console.error(msg);
    process.exit(1);
  }
  throw new Error(msg);
}
if (DEV && process.env.FLY_APP_NAME) die('Refusing to start: DEV=1 is not allowed on Fly (it disables authentication).');
if (!DEV && !TOKEN) die('Refusing to start: TELEGRAM_BOT_TOKEN is not set. For local demo data run `npm run demo` (DEV=1).');

// Demo data must never land in the real database, and a dev run must never silently
// open the live one: off Fly (which sets it in fly.toml) the path must be explicit.
if (!DEV && !process.env.DATABASE_PATH && !process.env.FLY_APP_NAME) {
  die('Refusing to start: DATABASE_PATH is not set. Set it explicitly (e.g. ./test.db for the test bot).');
}
const DB_PATH = process.env.DATABASE_PATH || (DEV ? './demo.db' : './grosplit.db');

// Stable across restarts and scale-to-zero (Telegram allows A-Za-z0-9_- here).
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update('grosplit-webhook:' + TOKEN).digest('hex');

const db = d.open(DB_PATH);
if (DEV) seed.ensureDemo(db);

// ── helpers ──────────────────────────────────────────────────────────────────

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
};
const ok = (res, body) => send(res, 200, body);
const fail = (res, code, message) => send(res, code, { error: message });

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => {
  const raw = await readBody(req, 1024 * 1024);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
};

// One log line per distinct message per minute (a scanner can hammer /api/).
const lastWarn = new Map();
function warnOncePerMinute(msg) {
  const now = Date.now();
  if (now - (lastWarn.get(msg) || 0) < 60_000) return;
  if (lastWarn.size > 100) lastWarn.clear();
  lastWarn.set(msg, now);
  console.warn(msg);
}

// Mutable only so tests can exercise the real (non-DEV) path without a network.
const auth = { dev: DEV, token: TOKEN };

class AuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Resolve the caller to a member row. THE trust boundary for every /api route.
async function authenticate(req) {
  if (auth.dev) {
    const h = d.firstHousehold(db);
    return d.members(db, h.id)[0];
  }
  const initData = req.headers['x-telegram-initdata'];
  const user = tg.verifyInitData(initData, auth.token); // throws on tamper/stale
  let member = d.memberByTelegramId(db, user.id);
  if (!member) {
    // First time this person opens the Mini App. The house IS the Telegram
    // group, so only people Telegram confirms are in it may join.
    const house = d.firstHousehold(db);
    if (!house || !house.telegram_chat_id) {
      throw new AuthError(403,
        "GroSplit isn't linked to a Telegram group yet. Add the bot to your house group first, then open GroSplit again.",
        'no_household');
    }
    if ((await tg.isInChat(auth.token, house.telegram_chat_id, user.id)) !== true) {
      throw new AuthError(403,
        "You're not in this house's Telegram group yet. Ask a housemate to add you, then open GroSplit again.",
        'not_in_group');
    }
    // Another request may have enrolled them while we awaited Telegram.
    member = d.memberByTelegramId(db, user.id) || d.addMember(db, house.id, {
      name: user.first_name || user.username || 'Housemate',
      telegramHandle: user.username ? '@' + user.username.toUpperCase() : null,
      telegramUserId: user.id,
    });
  }
  return member;
}

// Money at the trust boundary: a huge or non-finite value would be stored and
// then break every read of the receipt (and so /api/state) forever.
const MAX_CENTS = 10_000_000;
const MAX_POLLS = 15; // Telegram rate-limits a group to ~20 messages a minute
const validCents = (x) => Number.isSafeInteger(x) && Math.abs(x) <= MAX_CENTS;

// Everything the split needs, shaped for both the API and the poll monitor.
function receiptView(receiptId, me) {
  const r = d.receipt(db, receiptId);
  if (!r) return null;
  let members = d.members(db, r.household_id);
  const items = d.items(db, receiptId);
  const polled = d.polledItems(db, receiptId);
  const outs = d.optOuts(db, receiptId);
  const pollRows = d.polls(db, receiptId);
  const voteProgress = {};
  for (const v of d.voters(db, receiptId)) voteProgress[v.member_id] = (voteProgress[v.member_id] || 0) + 1;
  // "Voted" means answered EVERY poll of the receipt.
  const voterIds = Object.keys(voteProgress).map(Number).filter((m) => voteProgress[m] >= pollRows.length);

  let split;
  if (r.status === 'confirmed') {
    // Locked: serve the frozen copy, over exactly the members it covered.
    // (A confirmed row with no copy — e.g. seeded — is frozen on first read.)
    const frozen = r.locked_split ? JSON.parse(r.locked_split) : d.freezeSplit(db, receiptId);
    split = frozen.split;
    members = members.filter((m) => frozen.memberIds.includes(m.id));
  } else {
    split = d.computeReceiptSplit(db, r, members);
  }

  // Fix #6 — warn when our lines don't add up to what the paper says.
  const reconcile =
    r.printed_total_cents == null
      ? null
      : { printedCents: r.printed_total_cents, deltaCents: split.totalCents - r.printed_total_cents };

  return {
    receipt: r,
    items,
    polledItemIds: polled.map((p) => p.item_id),
    optOuts: outs.map((o) => ({ itemId: o.item_id, memberId: o.member_id })),
    voterIds,
    pollCount: pollRows.length,
    voteProgress,
    polls: pollRows.map((p) => ({
      id: p.id,
      part: p.part,
      itemIds: polled.filter((x) => x.poll_id === p.id).map((x) => x.item_id),
    })),
    members,
    split,
    evenShareCents: evenSplitCents(split.totalCents, members.length),
    reconcile,
    lookupsPending: lookup.pending(receiptId),
    meId: me.id,
    isGrocer: me.id === r.grocer_id,
    canManage: me.id === r.grocer_id || me.id === r.created_by,
  };
}

const guardHousehold = (r, me) => r && r.household_id === me.household_id;

// A receipt whose poll is live must not have its items edited underneath it.
const editable = (r) => r.status === 'review';

// ── API ──────────────────────────────────────────────────────────────────────

async function api(req, res, url, me) {
  await sweepExpiredPolls();
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, head, idRaw, tail, tailId] = seg;
  const id = Number(idRaw);

  if (head === 'state' && req.method === 'GET') {
    const house = d.household(db, me.household_id);
    const list = d.receipts(db, house.id).map((r) => {
      const v = receiptView(r.id, me);
      return {
        ...r,
        itemCount: v.items.length,
        totalCents: v.split.totalCents,
        subtotalCents: v.split.subtotalCents,
        evenShareCents: v.evenShareCents,
        votedCount: v.voterIds.length,
        pollCount: v.pollCount,
      };
    });
    return ok(res, { me, household: house, members: d.members(db, house.id), receipts: list, dev: DEV });
  }

  if (head === 'receipt' && !idRaw && req.method === 'POST') {
    const b = await readJson(req);
    if (!b.store || !String(b.store).trim()) return fail(res, 400, 'store name required');
    const grocerId = Number(b.grocerId) || me.id;
    if (!d.members(db, me.household_id).some((m) => m.id === grocerId)) {
      return fail(res, 400, 'grocer is not in this household');
    }
    const r = d.createReceipt(db, {
      householdId: me.household_id,
      store: String(b.store).trim(),
      grocerId,
      createdBy: me.id,
    });
    return ok(res, receiptView(r.id, me));
  }

  if (head === 'receipt' && idRaw) {
    const r = d.receipt(db, id);
    if (!guardHousehold(r, me)) return fail(res, 404, 'no such receipt');

    if (!tail && req.method === 'GET') return ok(res, receiptView(id, me));

    if (!tail && req.method === 'PATCH') {
      if (r.status !== 'review') return fail(res, 409, 'this receipt is no longer in review');
      const b = await readJson(req);
      const sets = [];
      const vals = [];
      if (b.store !== undefined) { sets.push('store = ?'); vals.push(String(b.store).trim()); }
      if (b.grocerId !== undefined && Number(b.grocerId) !== r.grocer_id) {
        // Only the grocer or whoever created the receipt may change the payer, and only to a housemate.
        if (me.id !== r.grocer_id && me.id !== r.created_by) {
          return fail(res, 403, 'Only the grocer or whoever added this receipt can change who paid');
        }
        const newId = Number(b.grocerId);
        if (!d.members(db, me.household_id).some((m) => m.id === newId)) {
          return fail(res, 400, 'grocer is not in this household');
        }
        sets.push('grocer_id = ?'); vals.push(newId);
      }
      if (b.taxEnabled !== undefined) { sets.push('tax_enabled = ?'); vals.push(b.taxEnabled ? 1 : 0); }
      if (b.taxMode !== undefined) { sets.push('tax_mode = ?'); vals.push(b.taxMode === 'even' ? 'even' : 'pro'); }
      if (b.taxCents !== undefined) {
        const t = Number(b.taxCents);
        if (!validCents(Math.round(t))) return fail(res, 400, 'taxCents is out of range');
        sets.push('tax_cents = ?'); vals.push(Math.round(t));
      }
      if (!sets.length) return ok(res, receiptView(id, me));
      db.prepare('UPDATE receipt SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
      return ok(res, receiptView(id, me));
    }

    if (tail === 'items' && req.method === 'PUT') {
      if (!editable(r)) return fail(res, 409, 'poll is live — items are locked');
      const b = await readJson(req);
      if (!Array.isArray(b.items)) return fail(res, 400, 'items array required');
      if (!Array.isArray(b.knownIds) || !b.knownIds.every(Number.isInteger)) {
        return fail(res, 400, 'knownIds (array of item ids) required');
      }
      if (!b.items.every((i) => i && typeof i === 'object' && !Array.isArray(i))) {
        return fail(res, 400, 'each item must be an object');
      }
      const rows = b.items.map((i) => ({
        id: i.id,
        name: String(i.name ?? '').trim().slice(0, 200) || 'Untitled item',
        priceCents: Number(i.priceCents ?? 0),
        quantity: typeof i.quantity === 'number' && Number.isFinite(i.quantity) ? i.quantity : null,
        aiFlagged: !!i.aiFlagged,
        aiGuess: typeof i.aiGuess === 'string' ? i.aiGuess.trim().slice(0, 200) || null : null,
        itemCode: typeof i.itemCode === 'string' ? i.itemCode.replace(/\s+/g, '').slice(0, 32) || null : null,
      }));
      if (!rows.every((i) => validCents(i.priceCents))) return fail(res, 400, 'priceCents is out of range');
      // The client's picture must match the server's exactly. Otherwise a stale screen
      // could resurrect a deleted line or overwrite a different line that reused its id.
      const current = new Set(d.items(db, id).map((i) => i.id));
      const known = new Set(b.knownIds);
      if (known.size !== current.size || ![...known].every((k) => current.has(k))) {
        return send(res, 409, { error: "Someone else just changed this receipt. Here's the latest.", code: 'stale' });
      }
      // A hand-made correction beats the shared cache: drop the cached label for a coded line
      // the user renamed to something other than what we suggested.
      const before = new Map(d.items(db, id).map((i) => [i.id, i]));
      const skey = lookup.storeKey(r.store);
      for (const row of rows) {
        const old = before.get(Number(row.id));
        const code = old && old.item_code;
        if (skey && code && row.name !== old.name && row.name !== old.ai_guess) {
          db.prepare('DELETE FROM product_lookup WHERE store_key = ? AND item_code = ?').run(skey, code);
        }
      }
      d.syncItems(db, id, rows, b.knownIds);
      return ok(res, receiptView(id, me));
    }

    if (!tail && req.method === 'DELETE') {
      if (r.status === 'polling') return fail(res, 409, 'close the poll first');
      if (r.status !== 'review') return fail(res, 409, 'this receipt is locked');
      if (me.id !== r.grocer_id && me.id !== r.created_by) {
        return fail(res, 403, 'Only the grocer or whoever added this receipt can delete it');
      }
      db.prepare('DELETE FROM receipt WHERE id = ?').run(id);
      return ok(res, { ok: true });
    }

    // Hand-edit one member's opt-outs: replaces their set on this receipt (F5).
    if (tail === 'optouts' && req.method === 'PUT') {
      const target = db.prepare('SELECT * FROM member WHERE id = ?').get(Number(tailId));
      if (!target || target.household_id !== me.household_id) return fail(res, 404, 'no such member');
      if (r.status === 'polling' || r.status === 'posting') return fail(res, 409, 'close the poll first');
      if (r.status !== 'review') return fail(res, 409, 'this split is locked');
      const b = await readJson(req);
      if (!Array.isArray(b.itemIds) || !b.itemIds.every(Number.isInteger)) return fail(res, 400, 'itemIds (array of item ids) required');
      const current = new Set(d.items(db, id).map((i) => i.id));
      if (b.knownIds !== undefined) {
        const known = new Set(Array.isArray(b.knownIds) ? b.knownIds : []);
        if (known.size !== current.size || ![...known].every((k) => current.has(k))) {
          return send(res, 409, { error: "Someone else just changed this receipt. Here's the latest.", code: 'stale' });
        }
      }
      const wanted = [...new Set(b.itemIds)];
      if (!wanted.every((x) => current.has(x))) return fail(res, 400, 'unknown item in selection');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM opt_out WHERE receipt_id = ? AND member_id = ?').run(id, target.id);
        const ins = db.prepare('INSERT INTO opt_out (receipt_id, item_id, member_id) VALUES (?, ?, ?)');
        for (const itemId of wanted) ins.run(id, itemId, target.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return ok(res, receiptView(id, me)); // poll_voter untouched: a hand edit is not a poll answer
    }

    if (tail === 'scan' && req.method === 'POST') {
      if (!editable(r)) return fail(res, 409, 'poll is live — items are locked');
      let buf;
      try {
        buf = await readBody(req);
      } catch {
        return fail(res, 413, 'that photo is too large');
      }
      if (!buf.length) return fail(res, 400, 'no image received');
      const mime = String(req.headers['content-type'] || 'image/jpeg').split(';')[0];
      let parsed;
      try {
        parsed = await parseReceipt(buf, mime);
      } catch (e) {
        return fail(res, 502, 'Could not read that receipt: ' + e.message);
      }
      const bad = parsed.items.some((i) => !validCents(i.priceCents)) || !validCents(parsed.taxCents) ||
        (parsed.printedTotalCents != null && !validCents(parsed.printedTotalCents));
      if (bad) return fail(res, 502, 'Could not read that receipt: an amount looked wrong. Try a clearer photo.');
      d.replaceItems(db, id, parsed.items);
      db.prepare('UPDATE receipt SET tax_cents = ?, printed_total_cents = ? WHERE id = ?')
        .run(parsed.taxCents, parsed.printedTotalCents, id);
      if (parsed.store) db.prepare('UPDATE receipt SET store = ? WHERE id = ?').run(parsed.store, id);
      lookup.afterScan(db, id); // cached labels now; web lookups continue in the background
      return ok(res, receiptView(id, me));
    }

    if (tail === 'poll' && req.method === 'POST') {
      if (!editable(r)) return fail(res, 409, 'a poll is already open on this receipt');
      const b = await readJson(req);
      const chosen = (b.itemIds || []).map(Number);
      if (!chosen.length) return fail(res, 400, 'pick at least one item');
      const picked = d.items(db, id).filter((i) => chosen.includes(i.id)); // receipt order
      if (picked.length !== chosen.length) return fail(res, 400, 'unknown item in selection');

      // Telegram polls take 10 options: up to 9 items plus "I'm in on all of these".
      // Split into balanced chunks (14 -> 7+7, 20 -> 7+7+6).
      const per = tg.MAX_POLL_OPTIONS - 1;
      const parts = Math.ceil(picked.length / per);
      const chunks = [];
      for (let k = 0, at = 0; k < parts; k++) {
        const size = Math.floor(picked.length / parts) + (k < picked.length % parts ? 1 : 0);
        chunks.push(picked.slice(at, at + size));
        at += size;
      }

      if (parts > MAX_POLLS) {
        return fail(res, 400, "That's more than " + MAX_POLLS + ' polls — pick the items people might actually want out of.');
      }

      const house = d.household(db, r.household_id);
      const view = receiptView(id, me);
      const money = (c) => house.currency + (c / 100).toFixed(2);
      const question = (k) =>
        (r.store + ' · ' + money(view.split.totalCents) + ' — ' + (parts > 1 ? (k + 1) + ' of ' + parts + ': ' : '') +
        "tick anything you're NOT in on. Closes in " + house.poll_window_hours + 'h.').slice(0, 300);
      const optionsFor = (chunk) => [
        ...chunk.map((i) => (i.name + ' — ' + money(i.price_cents)).slice(0, tg.MAX_OPTION_CHARS)),
        "✅ I'm in on all of these",
      ];

      // Claim the receipt before sending, so two concurrent requests can't both send (and
      // orphan one set of polls). poll_closes_at doubles as the claim time while posting.
      const nowSec = Math.floor(Date.now() / 1000);
      const claim = db.prepare("UPDATE receipt SET status = 'posting', poll_closes_at = ? WHERE id = ? AND status = 'review'")
        .run(nowSec, id);
      if (!claim.changes) return fail(res, 409, 'a poll is already being sent on this receipt');

      // Send sequentially, saving each poll's rows the moment it is out, so votes that arrive
      // while later polls are still sending are not lost. On ANY failure: stop what went out,
      // forget what was saved, and give the receipt back.
      const sent = [];
      let sending = true;
      try {
        d.clearPolls(db, id); // a new poll replaces the old ones completely (SPEC §7)
        const insPoll = db.prepare('INSERT INTO poll (receipt_id, part, telegram_poll_id, message_id) VALUES (?, ?, ?, ?)');
        const ins = db.prepare('INSERT INTO polled_item (receipt_id, item_id, option_index, poll_id) VALUES (?, ?, ?, ?)');
        for (let k = 0; k < chunks.length; k++) {
          let sp = null;
          if (!auth.dev && house.telegram_chat_id) {
            sp = await tg.sendPoll(auth.token, house.telegram_chat_id, question(k), optionsFor(chunks[k]));
            sent.push(sp);
          }
          sending = false; // a failure past this point is ours (e.g. an item vanished), not Telegram's
          db.exec('BEGIN');
          try {
            const pid = insPoll.run(id, k + 1, sp && sp.poll ? sp.poll.id : null, sp ? sp.message_id : null).lastInsertRowid;
            chunks[k].forEach((it, i) => ins.run(id, it.id, i, pid));
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          sending = true;
        }

        // Commit: only if the receipt is still ours. Anything else (locked, reverted) wins.
        const closesAt = Math.floor(Date.now() / 1000) + house.poll_window_hours * 3600;
        const done = db.prepare("UPDATE receipt SET status = 'polling', poll_closes_at = ? WHERE id = ? AND status = 'posting'")
          .run(closesAt, id);
        if (!done.changes) {
          for (const p of sent) await tg.stopPoll(auth.token, house.telegram_chat_id, p.message_id).catch(() => {});
          return fail(res, 409, 'this receipt changed while the poll was being sent');
        }
      } catch (e) {
        for (const p of sent) await tg.stopPoll(auth.token, house.telegram_chat_id, p.message_id).catch(() => {});
        if (d.receipt(db, id).status === 'posting') { // still ours
          d.clearPolls(db, id); // their opt-outs and voters go with them
          db.prepare("UPDATE receipt SET status = 'review', poll_closes_at = NULL WHERE id = ? AND status = 'posting'").run(id);
        }
        if (sending) return fail(res, 502, 'Telegram refused the poll: ' + e.message);
        throw e;
      }
      return ok(res, receiptView(id, me));
    }

    if (tail === 'close-poll' && req.method === 'POST') {
      if (r.status === 'posting') return fail(res, 409, 'the poll is still being sent');
      await closePoll(id);
      return ok(res, receiptView(id, me));
    }

    if (tail === 'confirm' && req.method === 'POST') {
      // Grocer gate — the whole point of grocerId being per receipt.
      if (me.id !== r.grocer_id) return fail(res, 403, 'Only the grocer can lock the split');
      if (r.status === 'posting') return fail(res, 409, 'the poll is still being sent');
      if (r.status === 'polling') await closePoll(id);
      if (r.status === 'confirmed') return ok(res, receiptView(id, me)); // already frozen
      db.prepare("UPDATE receipt SET status = 'confirmed' WHERE id = ?").run(id);
      d.freezeSplit(db, id);
      return ok(res, receiptView(id, me));
    }
  }

  if (head === 'member' && idRaw && req.method === 'PATCH') {
    const target = db.prepare('SELECT * FROM member WHERE id = ?').get(id);
    if (!target || target.household_id !== me.household_id) return fail(res, 404, 'no such member');
    const b = await readJson(req);
    if (b.avatarColor && d.PALETTE.includes(b.avatarColor)) {
      db.prepare('UPDATE member SET avatar_color = ? WHERE id = ?').run(b.avatarColor, id);
    }
    return ok(res, d.members(db, me.household_id));
  }

  if (head === 'household' && req.method === 'PATCH') {
    const b = await readJson(req);
    if (b.pollWindowHours !== undefined) {
      const h = Math.max(1, Math.min(48, Number(b.pollWindowHours) || 4));
      db.prepare('UPDATE household SET poll_window_hours = ? WHERE id = ?').run(h, me.household_id);
    }
    return ok(res, d.household(db, me.household_id));
  }

  return fail(res, 404, 'no such endpoint');
}

// ── poll lifecycle ───────────────────────────────────────────────────────────

async function closePoll(receiptId) {
  const r = d.receipt(db, receiptId);
  if (!r || r.status !== 'polling') return;
  const house = d.household(db, r.household_id);
  if (!auth.dev && house.telegram_chat_id) {
    for (const p of d.polls(db, receiptId)) {
      if (!p.message_id) continue;
      try {
        await tg.stopPoll(auth.token, house.telegram_chat_id, p.message_id);
      } catch {
        /* poll may already be closed or deleted — the split proceeds regardless */
      }
    }
  }
  const closed = db.prepare("UPDATE receipt SET status = 'review', poll_closes_at = NULL WHERE id = ? AND status = 'polling'")
    .run(receiptId);
  // Tell the house once per close: only the call that actually flipped the status speaks.
  if (closed.changes && house.telegram_chat_id) {
    const voted = new Set();
    const polls = d.polls(db, receiptId);
    const answered = new Map();
    for (const v of d.voters(db, receiptId)) answered.set(v.member_id, (answered.get(v.member_id) || 0) + 1);
    for (const [m, n] of answered) if (n >= polls.length) voted.add(m);
    const grocer = d.members(db, r.household_id).find((m) => m.id === r.grocer_id);
    const everyone = d.members(db, r.household_id).length; // the grocer votes too
    await say(house.telegram_chat_id,
      '🗳 Poll closed for ' + r.store + '. ' + voted.size + ' of ' + everyone + ' voted. ' +
      (grocer ? grocer.name : 'Grocer') + ', the split is ready to lock.');
  }
}

// A send that died mid-flight must not leave the receipt stuck, nor its polls open in
// Telegram: forget the saved polls (votes included), hand the receipt back, stop them.
// Longer than 15 polls x the 15s Telegram timeout.
const POSTING_TIMEOUT = 300;
async function revertPosting(claimedBefore) {
  const rows = db.prepare("SELECT id, household_id FROM receipt WHERE status = 'posting' AND poll_closes_at <= ?").all(claimedBefore);
  for (const r of rows) {
    const msgs = d.polls(db, r.id).map((p) => p.message_id).filter(Boolean);
    d.clearPolls(db, r.id);
    db.prepare("UPDATE receipt SET status = 'review', poll_closes_at = NULL WHERE id = ?").run(r.id);
    const chat = d.household(db, r.household_id).telegram_chat_id;
    if (!auth.dev && chat) for (const m of msgs) await tg.stopPoll(auth.token, chat, m).catch(() => {});
  }
}

// Close polls that have run past pollWindowHours.
//
// Lazily, on read — NOT on a timer. Nobody can observe a poll's state except
// through this server, so closing it the moment someone looks is
// indistinguishable from closing it on the stroke of the hour, and it means
// the machine is free to sleep when the household isn't shopping.
async function sweepExpiredPolls() {
  const now = Math.floor(Date.now() / 1000);
  await revertPosting(now - POSTING_TIMEOUT);
  const due = db
    .prepare("SELECT id FROM receipt WHERE status = 'polling' AND poll_closes_at IS NOT NULL AND poll_closes_at <= ?")
    .all(now);
  for (const row of due) await closePoll(row.id).catch(() => {});
}

// Votes count while the poll is live — and while the later polls of a multi-poll send are
// still going out ('posting', whose poll_closes_at is only the claim time). Not after the
// deadline, not after lock.
const voteOpen = (r) =>
  r.status === 'posting' || (r.status === 'polling' && Math.floor(Date.now() / 1000) < r.poll_closes_at);

// Apply one user's answers strictly in arrival order (a vote, then a quick retraction).
const answerChain = new Map();
function applyPollAnswer(answer) {
  const uid = answer.user ? String(answer.user.id) : '';
  const run = (answerChain.get(uid) || Promise.resolve()).then(() => applyPollAnswerNow(answer));
  const tail = run.catch(() => {});
  answerChain.set(uid, tail);
  tail.then(() => { if (answerChain.get(uid) === tail) answerChain.delete(uid); });
  return run;
}

// Telegram sends the option INDEX; polled_item maps index -> item.
async function applyPollAnswerNow(answer) {
  const poll = d.pollByTelegramId(db, answer.poll_id);
  const r = poll && d.receipt(db, poll.receipt_id);
  if (!r) return;
  // Votes count only while the poll is live: not after the deadline, not after lock.
  if (!voteOpen(r)) return;
  const user = answer.user;
  if (!user) return;
  let member = d.memberByTelegramId(db, user.id);
  if (!member) {
    // Polls can be forwarded, so a vote alone doesn't prove membership: ask Telegram.
    const house = d.household(db, r.household_id);
    if (!house.telegram_chat_id || (await tg.isInChat(auth.token, house.telegram_chat_id, user.id)) !== true) return;
    member = d.memberByTelegramId(db, user.id) || d.addMember(db, r.household_id, {
      name: user.first_name || user.username || 'Housemate',
      telegramHandle: user.username ? '@' + user.username.toUpperCase() : null,
      telegramUserId: user.id,
    });
    console.log('enrolled from poll vote:', member.name);
  }
  // The receipt may have been locked or re-polled while we awaited Telegram.
  const now = d.receipt(db, r.id);
  if (!now || !voteOpen(now) ||
      !d.pollByTelegramId(db, answer.poll_id) || d.pollByTelegramId(db, answer.poll_id).id !== poll.id) return;
  // This poll's options only. The trailing "in on all of these" option maps to no item.
  const mapping = d.polledItems(db, r.id).filter((m) => m.poll_id === poll.id);
  const chosen = new Set(
    (answer.option_ids || [])
      .map((idx) => {
        const hit = mapping.find((m) => m.option_index === idx);
        return hit ? hit.item_id : null;
      })
      .filter(Boolean),
  );

  db.exec('BEGIN');
  try {
    // Retraction sends an EMPTY option_ids, so always clear before inserting. Only this
    // poll's items: the member's answers to the receipt's other polls stay.
    db.prepare(
      'DELETE FROM opt_out WHERE receipt_id = ? AND member_id = ? AND item_id IN (SELECT item_id FROM polled_item WHERE poll_id = ?)',
    ).run(r.id, member.id, poll.id);
    const ins = db.prepare('INSERT INTO opt_out (receipt_id, item_id, member_id) VALUES (?, ?, ?)');
    for (const itemId of chosen) ins.run(r.id, itemId, member.id);
    // An empty answer is a retraction: they are back to "hasn't voted".
    if ((answer.option_ids || []).length === 0) {
      db.prepare('DELETE FROM poll_voter WHERE poll_id = ? AND member_id = ?').run(poll.id, member.id);
    } else {
      db.prepare('INSERT OR REPLACE INTO poll_voter (poll_id, member_id, voted_at) VALUES (?, ?, ?)')
        .run(poll.id, member.id, Math.floor(Date.now() / 1000));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Filled in at boot from getMe, so the welcome message can build its own link.
let BOT_USERNAME = '';
let BOT_ID = null;

// Was the bot just added to this group? my_chat_member also fires on promotion
// and demotion, so check the transition, not just the new status.
function wasJustAdded(update) {
  const m = update.my_chat_member;
  if (!m || !m.new_chat_member || !m.old_chat_member) return false;
  if (BOT_ID && m.new_chat_member.user && m.new_chat_member.user.id !== BOT_ID) return false;
  const left = ['left', 'kicked'];
  const joined = ['member', 'administrator', 'restricted'];
  return left.includes(m.old_chat_member.status) && joined.includes(m.new_chat_member.status);
}

async function greetGroup(chat) {
  if (!BOT_USERNAME) return;
  const link = 'https://t.me/' + BOT_USERNAME + '?startapp';

  // Only tell them to pin it if we can't do it ourselves.
  let canPin = false;
  try {
    const self = await tg.getChatMember(TOKEN, chat.id, BOT_ID);
    canPin = self.status === 'administrator' && self.can_pin_messages === true;
  } catch { /* assume not */ }

  const text =
    '🧾 GroSplit is in.\n\n' +
    'Whoever does the shop scans the receipt. Everyone else gets one poll for ' +
    'anything they want out of. Then it hands you the numbers to put in Tricount.\n\n' +
    'Everyone tap the button once, so I know who lives here.' +
    (canPin ? '' : '\n\nWorth pinning this — it is the way back in.');

  try {
    const sent = await tg.sendMessage(TOKEN, chat.id, text, {
      disable_web_page_preview: true,
      // A `url` button works in groups; a `web_app` button would not — those
      // are private-chat only. Pointing it at the t.me deep link gets us the
      // same result: tapping opens the Mini App.
      reply_markup: {
        inline_keyboard: [[{ text: '🛒  Split groceries now', url: link }]],
      },
    });
    if (canPin) await tg.pinChatMessage(TOKEN, chat.id, sent.message_id).catch(() => {});
    console.log('greeted group:', chat.title, canPin ? '(pinned)' : '(no pin rights)');
  } catch (e) {
    console.error('greeting failed:', e.message);
  }
}

// One log line per update: its kind and where it came from. Never message text, people's
// names or ids, or initData. (Group titles are fine; private chats are not named.)
// A group title is user-controlled: quote and cap it so it can't forge log lines.
const logTitle = (t) => JSON.stringify(String(t || '').slice(0, 64));

function describeUpdate(update) {
  const where = (c) => (c.type === 'group' || c.type === 'supergroup' ? c.type + ' ' + logTitle(c.title) : c.type + ' chat');
  if (update.poll_answer) return 'poll_answer';
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    const st = (x) => (x && x.status) || '?';
    return 'my_chat_member ' + st(m.old_chat_member) + '→' + st(m.new_chat_member) + ' in ' + (m.chat ? where(m.chat) : '?');
  }
  if (update.message) return 'message from ' + (update.message.chat ? where(update.message.chat) : '?');
  return 'other (' + Object.keys(update).filter((k) => k !== 'update_id').join(',') + ')';
}

// Test hook: the bot's identity normally comes from getMe at boot.
function _setBotForTests(username, id) { BOT_USERNAME = username; BOT_ID = id; }

// Replies are best-effort and never sent in DEV (no real bot).
const say = (chatId, text) => (auth.dev ? null : tg.sendMessage(auth.token, chatId, text).catch(() => {}));

// /start or /start@thisbot (the form groups use, and it reaches us even with privacy mode on).
function isStartCommand(update) {
  const m = /^\/start(?:@(\w+))?(?:\s|$)/.exec((update.message && update.message.text) || '');
  if (!m) return false;
  return !m[1] || !BOT_USERNAME || m[1].toLowerCase() === BOT_USERNAME.toLowerCase();
}

const toldOtherGroup = new Set();

async function handleUpdate(update) {
  console.log('update:', describeUpdate(update));
  await sweepExpiredPolls(); // so a late vote also closes the poll in Telegram
  if (update.poll_answer) await applyPollAnswer(update.poll_answer);

  // The group IS the household. Adding the bot to a group bootstraps it, and
  // learns the chat id, so nobody has to look one up by hand.
  // my_chat_member fires on being added regardless of privacy mode, which is
  // why privacy mode can stay on.
  // Basic group -> supergroup: the chat id changes. Follow it FIRST, so the next message in
  // the new id isn't mistaken for a stranger group. (Delivered even in privacy mode.)
  const msg = update.message;
  if (msg && msg.chat && (msg.migrate_to_chat_id || msg.migrate_from_chat_id)) {
    const house = d.firstHousehold(db);
    const oldId = msg.migrate_to_chat_id ? msg.chat.id : msg.migrate_from_chat_id;
    const newId = msg.migrate_to_chat_id || msg.chat.id;
    if (house && house.telegram_chat_id === String(oldId)) {
      db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run(String(newId), house.id);
      console.log('household group migrated to a supergroup');
    }
    return;
  }

  const chat = (msg && msg.chat) || (update.my_chat_member && update.my_chat_member.chat);
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  // Being removed from a group: nothing to set up, nobody to greet.
  const mc = update.my_chat_member;
  if (mc && mc.new_chat_member && ['left', 'kicked'].includes(mc.new_chat_member.status)) return;

  const start = isStartCommand(update);
  const added = wasJustAdded(update);
  const title = chat.title || 'your group';
  let setUp = false;
  const known = d.householdByChatId(db, chat.id);
  if (!known) {
    const house = d.firstHousehold(db);
    if (house && house.telegram_chat_id) {
      // The one-household rule. A stranger group gets one polite reply, never the greeting.
      if ((start || added) && !toldOtherGroup.has(chat.id)) {
        toldOtherGroup.add(chat.id);
        console.log('ignoring group ' + logTitle(chat.title) + ': the household is already linked to another group');
        await say(chat.id, "I'm already set up for another group.");
      }
      return;
    }
    // Creating or linking: only the owner may, when TELEGRAM_OWNER_ID is set.
    const owner = process.env.TELEGRAM_OWNER_ID;
    const actor = update.my_chat_member ? update.my_chat_member.from : msg && msg.from;
    if (owner && !(actor && String(actor.id) === String(owner))) {
      console.log('waiting for the owner to set up the household');
      return;
    }
    if (!house) {
      d.createHousehold(db, { name: chat.title || 'My household', telegramChatId: String(chat.id) });
      console.log('household created from group', logTitle(chat.title));
    } else {
      db.prepare('UPDATE household SET telegram_chat_id = ?, name = ? WHERE id = ?')
        .run(String(chat.id), chat.title || house.name, house.id);
      console.log('household linked to group', logTitle(chat.title));
    }
    setUp = true;
  }

  // Say hello last, so the household exists by the time anyone taps the link. A /start that
  // sets things up gets the button too, since the reply below points at it.
  if (added || setUp) await greetGroup(chat);
  if (setUp) {
    await say(chat.id, '✅ GroSplit is set up for ' + title + '. Everyone tap the button above once to join.');
  } else if (start && known) {
    const n = d.members(db, known.id).length;
    await say(chat.id, '✅ GroSplit is set up here — ' + n + ' housemate' + (n === 1 ? ' has' : 's have') + ' joined.');
  }
}

// ── static + routing ─────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // Never let a crafted path escape public/.
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'nope');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache', // a stale app.js would send old request shapes after a deploy
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/webhook') {
      if (!tg.verifyWebhookSecret(req.headers['x-telegram-bot-api-secret-token'], WEBHOOK_SECRET)) {
        return fail(res, 401, 'bad secret');
      }
      const update = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      // Answer Telegram immediately; it retries on a slow reply, which would
      // double-process the update.
      ok(res, { ok: true });
      handleUpdate(update).catch((e) => console.error('update failed:', e.message));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      let me;
      try {
        me = await authenticate(req);
      } catch (e) {
        if (e instanceof AuthError) return send(res, e.status, { error: e.message, code: e.code });
        warnOncePerMinute('sign-in rejected: ' + e.message); // the reason only — never initData
        return fail(res, 401, e.message);
      }
      return await api(req, res, url, me);
    }

    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    return fail(res, 500, e.message || 'server error');
  }
});

// Nothing can be mid-send at boot, so any 'posting' left over is from a crash.
revertPosting(Number.MAX_SAFE_INTEGER).catch((e) => console.error('revertPosting:', e.message));

if (require.main === module) {
  server.listen(PORT, async () => {
    console.log(
      'GroSplit on http://localhost:' + PORT + (DEV ? '  [DEV — no bot token, demo data seeded]' : ''),
    );
    if (!DEV) {
      try {
        const me = await tg.getMe(TOKEN);
        BOT_USERNAME = me.username;
        BOT_ID = me.id;
        console.log('bot: @' + BOT_USERNAME + '  ·  link: https://t.me/' + BOT_USERNAME + '?startapp');
      } catch (e) {
        console.error('getMe failed:', e.message);
      }
    }
    if (!DEV) {
      const mode = await startUpdates({ fly: process.env.FLY_APP_NAME, publicUrl: PUBLIC_URL });
      if (mode === 'longpoll') longPoll();
    }
  });
}

// How this process receives Telegram updates. Returns 'webhook' | 'busy' | 'longpoll'.
// Two bots: production (on Fly) registers a webhook; a laptop long-polls the TEST
// bot and must never touch a webhook that a deployed app depends on.
async function startUpdates({ fly, publicUrl }) {
  if (fly) {
    const base = publicUrl || 'https://' + fly + '.fly.dev';
    try {
      await tg.setWebhook(TOKEN, base.replace(/\/$/, '') + '/webhook', WEBHOOK_SECRET);
      console.log('webhook registered at', base.replace(/\/$/, '') + '/webhook');
    } catch (e) {
      console.error('webhook registration failed:', e.message);
    }
    return 'webhook';
  }
  let info = null;
  try {
    info = await tg.getWebhookInfo(TOKEN);
  } catch (e) {
    // Can't tell, so don't risk stealing a live bot's updates.
    console.error('getWebhookInfo failed, not long-polling:', e.message);
    return 'busy';
  }
  if (info && info.url) {
    console.log('this bot is in use by ' + info.url + ' — use the test bot locally');
    return 'busy';
  }
  console.log('no webhook set — long-polling for updates');
  return 'longpoll';
}

const POLL_UPDATES = ['message', 'poll_answer', 'my_chat_member'];

async function longPoll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.getUpdates(TOKEN, offset, POLL_UPDATES);
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e) {
          console.error('update failed:', e.message);
        }
      }
    } catch (e) {
      // Network blip or Telegram hiccup — wait a beat rather than hot-looping.
      console.error('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = {
  server, db, auth, _setBotForTests, warnOncePerMinute, WEBHOOK_SECRET, startUpdates, handleUpdate, applyPollAnswer, closePoll, receiptView, wasJustAdded,
};
