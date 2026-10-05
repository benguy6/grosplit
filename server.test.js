'use strict';

// End-to-end over real HTTP against the real SQLite file, in DEV mode
// (no bot token, so initData is skipped and the caller is the first member).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = path.join(os.tmpdir(), 'grosplit-test-' + process.pid + '.db');
process.env.DATABASE_PATH = TMP;
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.DEV = '1'; // DEV must be explicit (B4)
delete process.env.FLY_APP_NAME;

const { server, db, handleUpdate } = require('./server.js');
const d = require('./db.js');

let base;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => {
  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + suffix); } catch { /* fine */ }
  }
});

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('GET /api/state returns the seeded household', async () => {
  const { status, body } = await api('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(body.household.name, 'Blk 42 · #05-11');
  assert.equal(body.members.length, 6);
  assert.equal(body.me.name, 'Ben');
  assert.equal(body.receipts.length, 6);

  const active = body.receipts.find((r) => r.status === 'review');
  assert.equal(active.totalCents, 13797, 'seeded receipt matches the design: $137.97');
  assert.equal(active.subtotalCents, 12658);
  assert.equal(active.evenShareCents, 2300, '$23.00 each');
});

test('creating a receipt requires a store name', async () => {
  const blank = await api('POST', '/api/receipt', { store: '   ' });
  assert.equal(blank.status, 400);
});

test('rejects a grocer from outside the household', async () => {
  const r = await api('POST', '/api/receipt', { store: 'Kroger', grocerId: 999999 });
  assert.equal(r.status, 400);
});

test('full flow: create, add items, poll, vote, retract, close, lock', async () => {
  const state = await api('GET', '/api/state');
  const members = state.body.members;
  const me = state.body.me;

  const created = await api('POST', '/api/receipt', { store: 'Costco', grocerId: me.id });
  assert.equal(created.status, 200);
  const id = created.body.receipt.id;

  // Items: two ordinary lines plus a coupon.
  const put = await api('PUT', `/api/receipt/${id}/items`, {
    items: [
      { name: 'Protein powder', priceCents: 2990 },
      { name: 'Coffee beans', priceCents: 1850 },
      { name: 'MFR COUPON', priceCents: -240 },
    ],
    knownIds: [],
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.split.subtotalCents, 4600);

  // Tax read off the receipt, pro-rata.
  const taxed = await api('PATCH', `/api/receipt/${id}`, { taxCents: 414, taxEnabled: true, taxMode: 'pro' });
  assert.equal(taxed.body.split.totalCents, 5014);
  const sum = (v) => Object.values(v.split.shares).reduce((s, x) => s + x.cents, 0);
  assert.equal(sum(taxed.body), 5014, 'shares sum to total');

  // Open a poll on the protein powder.
  const proteinId = put.body.items.find((i) => i.name === 'Protein powder').id;
  const polled = await api('POST', `/api/receipt/${id}/poll`, { itemIds: [proteinId] });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.receipt.status, 'polling');

  // Items are now locked underneath the live poll.
  const blocked = await api('PUT', `/api/receipt/${id}/items`, { items: [], knownIds: [] });
  assert.equal(blocked.status, 409, 'cannot edit items while a poll is live');

  // Simulate two housemates voting out via the webhook path.
  const [, aisha, mira] = members;
  db.prepare('UPDATE member SET telegram_user_id = ? WHERE id = ?').run('5001', aisha.id);
  db.prepare('UPDATE member SET telegram_user_id = ? WHERE id = ?').run('5002', mira.id);
  db.prepare("UPDATE receipt SET telegram_poll_id = 'testpoll' WHERE id = ?").run(id);

  await handleUpdate({ poll_answer: { poll_id: 'testpoll', user: { id: 5001 }, option_ids: [0] } });
  await handleUpdate({ poll_answer: { poll_id: 'testpoll', user: { id: 5002 }, option_ids: [0] } });

  let view = (await api('GET', `/api/receipt/${id}`)).body;
  assert.equal(view.optOuts.length, 2);
  assert.equal(view.voterIds.length, 2);
  assert.equal(view.split.shares[aisha.id].itemCount, 2, 'Aisha is out of one of three lines');
  assert.equal(sum(view), 5014, 'shares still sum to total after opt-outs');

  // Mira changes her mind — Telegram sends an EMPTY option_ids.
  await handleUpdate({ poll_answer: { poll_id: 'testpoll', user: { id: 5002 }, option_ids: [] } });
  view = (await api('GET', `/api/receipt/${id}`)).body;
  assert.equal(view.optOuts.length, 1, 'retraction removes the opt-out');
  assert.equal(view.voterIds.length, 2, 'but she still counts as having voted');

  // Close and lock.
  const closed = await api('POST', `/api/receipt/${id}/close-poll`);
  assert.equal(closed.body.receipt.status, 'review');
  const locked = await api('POST', `/api/receipt/${id}/confirm`);
  assert.equal(locked.status, 200);
  assert.equal(locked.body.receipt.status, 'confirmed');
  assert.equal(sum(locked.body), 5014);
});

test('the grocer gate: a non-grocer cannot lock the split', async () => {
  const state = await api('GET', '/api/state');
  const notMe = state.body.members.find((m) => m.id !== state.body.me.id);

  const created = await api('POST', '/api/receipt', { store: 'Safeway', grocerId: notMe.id });
  const id = created.body.receipt.id;
  await api('PUT', `/api/receipt/${id}/items`, { items: [{ name: 'Milk', priceCents: 400 }], knownIds: [] });

  const denied = await api('POST', `/api/receipt/${id}/confirm`);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Only the grocer/);

  const view = (await api('GET', `/api/receipt/${id}`)).body;
  assert.equal(view.isGrocer, false, 'UI shows the waiting-on-them state');
});

test('the poll option cap is enforced server-side, not just in the UI', async () => {
  const created = await api('POST', '/api/receipt', { store: 'Target' });
  const id = created.body.receipt.id;
  const many = Array.from({ length: 12 }, (_, i) => ({ name: 'Item ' + i, priceCents: 100 + i }));
  const put = await api('PUT', `/api/receipt/${id}/items`, { items: many, knownIds: [] });

  const tooMany = await api('POST', `/api/receipt/${id}/poll`, {
    itemIds: put.body.items.map((i) => i.id),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /at most 10/);

  const empty = await api('POST', `/api/receipt/${id}/poll`, { itemIds: [] });
  assert.equal(empty.status, 400);
});

test('reconciliation surfaces a mismatch against the printed total', async () => {
  const created = await api('POST', '/api/receipt', { store: 'Kroger' });
  const id = created.body.receipt.id;
  await api('PUT', `/api/receipt/${id}/items`, { items: [{ name: 'Eggs', priceCents: 599 }], knownIds: [] });

  let view = (await api('GET', `/api/receipt/${id}`)).body;
  assert.equal(view.reconcile, null, 'no printed total means no warning');

  db.prepare('UPDATE receipt SET printed_total_cents = 700 WHERE id = ?').run(id);
  view = (await api('GET', `/api/receipt/${id}`)).body;
  assert.equal(view.reconcile.deltaCents, -101, 'our lines are $1.01 short of the paper');
});

test('a receipt from another household is not readable', async () => {
  const other = d.createHousehold(db, { name: 'Someone else' });
  const stranger = d.addMember(db, other.id, { name: 'Stranger' });
  const theirs = d.createReceipt(db, {
    householdId: other.id, store: 'Not yours', grocerId: stranger.id,
  });
  const res = await api('GET', `/api/receipt/${theirs.id}`);
  assert.equal(res.status, 404);
});

test('B9/B12: CSV export and the removed settings are gone', async () => {
  const state = (await api('GET', '/api/state')).body;
  const res = await fetch(base + `/api/receipt/${state.receipts[0].id}/export.csv`);
  assert.equal(res.status, 404);
  const before = state.household.auto_flag_staples;
  await api('PATCH', '/api/household', { autoFlagStaples: !before, roundToCent: false });
  assert.equal(d.firstHousehold(db).auto_flag_staples, before);
  assert.equal(d.firstHousehold(db).round_to_cent, 1);
});

test('unknown endpoints 404 rather than 500', async () => {
  const res = await api('GET', '/api/nonsense');
  assert.equal(res.status, 404);
});

// ── group-join greeting ─────────────────────────────────────────────────────
// my_chat_member fires on promotion and demotion too, so the greeting must
// trigger on the join TRANSITION only — otherwise the bot re-greets the group
// every time someone changes its admin rights.

const { wasJustAdded } = require('./server.js');
const transition = (from, to) => ({
  my_chat_member: {
    chat: { id: -1, type: 'group', title: 'g' },
    old_chat_member: { status: from },
    new_chat_member: { status: to },
  },
});

test('greets on a real join', () => {
  assert.equal(wasJustAdded(transition('left', 'member')), true);
  assert.equal(wasJustAdded(transition('kicked', 'member')), true);
  assert.equal(wasJustAdded(transition('left', 'administrator')), true);
});

test('does not re-greet on promotion, demotion or removal', () => {
  assert.equal(wasJustAdded(transition('member', 'administrator')), false, 'promoted');
  assert.equal(wasJustAdded(transition('administrator', 'member')), false, 'demoted');
  assert.equal(wasJustAdded(transition('member', 'left')), false, 'removed');
  assert.equal(wasJustAdded(transition('administrator', 'kicked')), false, 'banned');
});

test('ignores updates that are not membership changes at all', () => {
  assert.equal(wasJustAdded({}), false);
  assert.equal(wasJustAdded({ poll_answer: { poll_id: 'x' } }), false);
  assert.equal(wasJustAdded({ my_chat_member: { chat: {} } }), false, 'missing member fields');
});

// ── round 1 fixes ───────────────────────────────────────────────────────────

const mkReceipt = async (store, items) => {
  const me = (await api('GET', '/api/state')).body.me;
  const id = (await api('POST', '/api/receipt', { store, grocerId: me.id })).body.receipt.id;
  const put = await api('PUT', `/api/receipt/${id}/items`, { items, knownIds: [] });
  return { id, me, items: put.body.items };
};
const voteAs = async (member, tgId, pollId, optionIds) => {
  db.prepare('UPDATE member SET telegram_user_id = ? WHERE id = ?').run(String(tgId), member.id);
  await handleUpdate({ poll_answer: { poll_id: pollId, user: { id: tgId }, option_ids: optionIds } });
};

test('B1: editing one item keeps opt-outs on the others; deleting drops only its own', async () => {
  const { id, items } = await mkReceipt('B1 Mart', [
    { name: 'Wine', priceCents: 2000 }, { name: 'Milk', priceCents: 400 }, { name: 'Eggs', priceCents: 600 },
  ]);
  const [wine, milk, eggs] = items;
  const aisha = (await api('GET', '/api/state')).body.members[1];
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [wine.id, eggs.id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b1poll' WHERE id = ?").run(id);
  await voteAs(aisha, 7001, 'b1poll', [0, 1]);
  await api('POST', `/api/receipt/${id}/close-poll`);
  assert.equal(d.optOuts(db, id).length, 2);

  // Rename a DIFFERENT item, sending ids back.
  const put = await api('PUT', `/api/receipt/${id}/items`, { items: [
    { id: wine.id, name: 'Wine', priceCents: 2000 },
    { id: milk.id, name: 'Oat milk', priceCents: 450 },
    { id: eggs.id, name: 'Eggs', priceCents: 600 },
  ], knownIds: [wine.id, milk.id, eggs.id] });
  assert.equal(put.status, 200);
  assert.equal(put.body.optOuts.length, 2, 'opt-outs survive');
  assert.equal(put.body.polledItemIds.length, 2, 'poll rows survive');
  assert.deepEqual(put.body.items.map((i) => i.id), [wine.id, milk.id, eggs.id], 'ids stable');

  // Delete the polled wine; a foreign item id must be inserted as new, never touched.
  const other = await mkReceipt('Other', [{ name: 'Theirs', priceCents: 100 }]);
  const del = await api('PUT', `/api/receipt/${id}/items`, { items: [
    { id: milk.id, name: 'Oat milk', priceCents: 450 },
    { id: eggs.id, name: 'Eggs', priceCents: 600 },
    { id: other.items[0].id, name: 'New', priceCents: 50 },
  ], knownIds: [wine.id, milk.id, eggs.id] });
  assert.deepEqual(del.body.optOuts.map((o) => o.itemId), [eggs.id], 'only the wine opt-out is gone');
  assert.equal(d.items(db, other.id)[0].name, 'Theirs', 'other receipt untouched');
  assert.equal(del.body.items.length, 3);
  assert.notEqual(del.body.items[2].id, other.items[0].id, 'foreign id inserted as new');
});

test('B2: a locked split does not change when a member joins; late votes are ignored', async () => {
  const { id, items } = await mkReceipt('B2 Mart', [{ name: 'Wine', priceCents: 3000 }, { name: 'Rice', priceCents: 1001 }]);
  const ms = (await api('GET', '/api/state')).body.members;
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b2poll' WHERE id = ?").run(id);
  await voteAs(ms[1], 7002, 'b2poll', [0]);
  const locked = (await api('POST', `/api/receipt/${id}/confirm`)).body;
  assert.equal(locked.receipt.status, 'confirmed');

  d.addMember(db, ms[0].household_id, { name: 'Latecomer' });
  await voteAs(ms[2], 7003, 'b2poll', [0]); // late vote after lock

  const after = (await api('GET', `/api/receipt/${id}`)).body;
  assert.deepEqual(after.split, locked.split, 'shares frozen');
  assert.deepEqual(after.members.map((m) => m.id), locked.members.map((m) => m.id), 'member list frozen');
  assert.equal(after.evenShareCents, locked.evenShareCents);
  assert.equal(after.optOuts.length, locked.optOuts.length, 'late vote ignored');
  for (const m of after.members) assert.ok(after.split.shares[m.id], 'every listed member has a share');
});

test('B8: votes after the deadline are ignored', async () => {
  const { id, items } = await mkReceipt('B8 Mart', [{ name: 'Wine', priceCents: 3000 }]);
  const ms = (await api('GET', '/api/state')).body.members;
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b8poll', poll_closes_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000) - 5, id);
  await voteAs(ms[1], 7004, 'b8poll', [0]);
  assert.equal(d.optOuts(db, id).length, 0);
});

test('B2 migration: an old database gains the column and its confirmed receipts get frozen', () => {
  const p = path.join(os.tmpdir(), 'grosplit-mig-' + process.pid + '.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(p);
  old.exec(d.SCHEMA.replace(/,\s*locked_split\s+TEXT,\s*created_by\s+INTEGER/, ''));
  old.exec("INSERT INTO household (id, name) VALUES (1, 'h');" +
    "INSERT INTO member VALUES (1, 1, 'A', 'A', '#000', NULL, NULL);" +
    "INSERT INTO receipt (id, household_id, store, created_at, grocer_id, status) VALUES (1, 1, 's', 0, 1, 'confirmed');");
  assert.ok(!old.prepare('PRAGMA table_info(receipt)').all().some((c) => ['locked_split', 'created_by'].includes(c.name)));
  old.close();
  const mig = d.open(p);
  const frozen = JSON.parse(mig.prepare('SELECT locked_split FROM receipt WHERE id = 1').get().locked_split);
  assert.deepEqual(frozen.memberIds, [1]);
  assert.equal(mig.prepare('SELECT created_by FROM receipt WHERE id = 1').get().created_by, null);
  mig.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + suffix); } catch { /* fine */ } }
});

test('B3: only people in the Telegram group can join', async () => {
  const { auth } = require('./server.js');
  const tg = require('./telegram.js');
  const real = { v: tg.verifyInitData, c: tg.isInChat };
  const house = d.firstHousehold(db);
  const call = () => fetch(base + '/api/state', { headers: { 'x-telegram-initdata': 'x' } });
  const before = d.members(db, house.id).length;
  auth.dev = false; auth.token = 'tok';
  try {
    tg.verifyInitData = () => ({ id: 9001, first_name: 'Rando' });
    tg.isInChat = async () => true;

    let res = await call();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'no_household');

    db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-100', house.id);
    tg.isInChat = async () => false;
    res = await call();
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'not_in_group');
    assert.match(body.error, /not in this house's Telegram group/);
    assert.equal(d.members(db, house.id).length, before, 'not enrolled');
    assert.equal(d.memberByTelegramId(db, 9001), undefined);

    tg.isInChat = async () => true;
    res = await call();
    assert.equal(res.status, 200);
    assert.equal(d.members(db, house.id).length, before + 1);
  } finally {
    auth.dev = true; auth.token = '';
    tg.verifyInitData = real.v; tg.isInChat = real.c;
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  }
});

test('B5: only the grocer can change the grocer, and only to a housemate', async () => {
  const state = (await api('GET', '/api/state')).body;
  const notMe = state.members.find((m) => m.id !== state.me.id);
  // Created by someone else (or legacy NULL): I am neither grocer nor creator.
  const id = d.createReceipt(db, { householdId: state.me.household_id, store: 'B5', grocerId: notMe.id }).id;

  const steal = await api('PATCH', `/api/receipt/${id}`, { grocerId: state.me.id });
  assert.equal(steal.status, 403);
  assert.equal(d.receipt(db, id).grocer_id, notMe.id, 'grocer unchanged');

  const same = await api('PATCH', `/api/receipt/${id}`, { grocerId: notMe.id, store: 'B5b' });
  assert.equal(same.status, 200, 'resending the current grocer is a no-op');

  const mine = (await api('POST', '/api/receipt', { store: 'B5c' })).body.receipt.id;
  assert.equal((await api('PATCH', `/api/receipt/${mine}`, { grocerId: 999999 })).status, 400);
  assert.equal((await api('PATCH', `/api/receipt/${mine}`, { grocerId: notMe.id })).status, 200);
  assert.equal((await api('PATCH', `/api/receipt/${mine}`, { taxCents: 'abc' })).status, 400);
});

test('B4: server refuses to start without a token unless DEV=1', async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const env = { ...process.env, PORT: '0', DATABASE_PATH: path.join(os.tmpdir(), 'grosplit-b4-' + process.pid + '.db') };
  delete env.TELEGRAM_BOT_TOKEN; delete env.DEV; delete env.FLY_APP_NAME;
  const run = (extra) => spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 });
  const noDev = run({});
  assert.notEqual(noDev.status, 0);
  assert.match(noDev.stderr, /TELEGRAM_BOT_TOKEN/);
  const onFly = run({ DEV: '1', FLY_APP_NAME: 'x' });
  assert.notEqual(onFly.status, 0);
  assert.match(onFly.stderr, /Fly/);

  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...env, DEV: '1' } });
  const out = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; if (/GroSplit on/.test(buf)) resolve(buf); });
    child.on('exit', () => resolve(buf));
    setTimeout(() => resolve(buf), 4000);
  });
  child.kill();
  assert.match(out, /GroSplit on/);
  await new Promise((r) => setTimeout(r, 300));
  for (const suffix of ['', '-wal', '-shm']) { fs.rmSync(env.DATABASE_PATH + suffix, { force: true, maxRetries: 5, retryDelay: 100 }); }
});

// ── round 1b ────────────────────────────────────────────────────────────────

test('B28: absurd money values are rejected at the boundary and never poison /api/state', async () => {
  const { id } = await mkReceipt('B28 Mart', [{ name: 'Milk', priceCents: 400 }]);
  for (const bad of [1e17, 'Infinity', 10_000_001, 1.5e9]) {
    const r = await api('PUT', `/api/receipt/${id}/items`, { items: [{ name: 'x', priceCents: bad }], knownIds: [] });
    assert.equal(r.status, 400, 'price ' + bad);
    assert.equal((await api('PATCH', `/api/receipt/${id}`, { taxCents: bad })).status, 400, 'tax ' + bad);
  }
  assert.equal((await api('GET', '/api/state')).status, 200);
});

test('B29: a vote from someone not in the group is ignored and does not enrol them', async () => {
  const tg = require('./telegram.js');
  const real = tg.isInChat;
  const house = d.firstHousehold(db);
  const { id, items } = await mkReceipt('B29 Mart', [{ name: 'Wine', priceCents: 3000 }]);
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b29poll' WHERE id = ?").run(id);
  db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-100', house.id);
  const before = d.members(db, house.id).length;
  const vote = (uid) => handleUpdate({ poll_answer: { poll_id: 'b29poll', user: { id: uid, first_name: 'X' }, option_ids: [0] } });
  try {
    tg.isInChat = async () => false;
    await vote(9101);
    assert.equal(d.members(db, house.id).length, before, 'outsider not enrolled');
    assert.equal(d.optOuts(db, id).length, 0);
    tg.isInChat = async () => true;
    await vote(9102);
    assert.equal(d.members(db, house.id).length, before + 1);
    assert.equal(d.optOuts(db, id).length, 1);
  } finally {
    tg.isInChat = real;
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  }
});

test('B30: webhook only on Fly; off Fly never touches a webhook that is in use', async () => {
  const { startUpdates } = require('./server.js');
  const tg = require('./telegram.js');
  const real = { w: tg.getWebhookInfo, s: tg.setWebhook, x: tg.deleteWebhook };
  const calls = [];
  tg.setWebhook = async (_t, url) => { calls.push('set ' + url); };
  tg.deleteWebhook = async () => { calls.push('delete'); };
  try {
    tg.getWebhookInfo = async () => ({ url: 'https://prod.fly.dev/webhook' });
    assert.equal(await startUpdates({ fly: undefined, publicUrl: '' }), 'busy');
    tg.getWebhookInfo = async () => ({ url: '' });
    assert.equal(await startUpdates({ fly: undefined, publicUrl: 'https://tunnel.example' }), 'longpoll');
    assert.deepEqual(calls, [], 'off Fly: no setWebhook, no deleteWebhook');
    assert.equal(await startUpdates({ fly: 'myapp', publicUrl: '' }), 'webhook');
    assert.deepEqual(calls, ['set https://myapp.fly.dev/webhook']);
  } finally {
    tg.getWebhookInfo = real.w; tg.setWebhook = real.s; tg.deleteWebhook = real.x;
  }
});

test('B10: the webhook secret is derived from the token, so it survives restarts', () => {
  const { WEBHOOK_SECRET } = require('./server.js');
  const want = require('node:crypto').createHash('sha256')
    .update('grosplit-webhook:' + (process.env.TELEGRAM_BOT_TOKEN || '')).digest('hex');
  assert.equal(process.env.WEBHOOK_SECRET, undefined);
  assert.equal(WEBHOOK_SECRET, want);
});

test('B31: a late vote closes the expired poll', async () => {
  const { id, items } = await mkReceipt('B31 Mart', [{ name: 'Wine', priceCents: 3000 }]);
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare('UPDATE receipt SET poll_closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, id);
  await handleUpdate({ poll_answer: { poll_id: 'nothing', user: { id: 1 }, option_ids: [] } });
  assert.equal(d.receipt(db, id).status, 'review');
});

test('B32: a stale client only deletes lines it knew about', async () => {
  const { id, items } = await mkReceipt('B32 Mart', [{ name: 'eggs', priceCents: 300 }, { name: 'milk', priceCents: 200 }]);
  const [eggs, milk] = items;
  // A adds steak.
  const a = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: eggs.id, name: 'eggs', priceCents: 300 }, { id: milk.id, name: 'milk', priceCents: 200 }, { name: 'steak', priceCents: 900 }],
    knownIds: [eggs.id, milk.id],
  });
  assert.ok(a.body.items.some((i) => i.name === 'steak'));
  // B (stale: has never seen steak) deletes eggs.
  const b = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: milk.id, name: 'milk', priceCents: 200 }], knownIds: [eggs.id, milk.id],
  });
  assert.equal(b.status, 409, 'stale picture is refused outright (B32 leftover)');
  assert.equal(b.body.code, 'stale');
  assert.deepEqual(d.items(db, id).map((i) => i.name).sort(), ['eggs', 'milk', 'steak'], 'nothing changed');
  assert.equal((await api('PUT', `/api/receipt/${id}/items`, { items: [] })).status, 400, 'knownIds required');
  assert.equal((await api('PUT', `/api/receipt/${id}/items`, { items: [], knownIds: ['a'] })).status, 400);
});

test('B33: creator or grocer can change payer / delete in review; others cannot', async () => {
  const state = (await api('GET', '/api/state')).body;
  const me = state.me;
  const other = state.members.find((m) => m.id !== me.id);
  const third = state.members.find((m) => m.id !== me.id && m.id !== other.id);
  // Created by me, paid by someone else: I (creator) may still manage it.
  const mine = (await api('POST', '/api/receipt', { store: 'B33', grocerId: other.id })).body;
  assert.equal(mine.canManage, true);
  assert.equal((await api('PATCH', `/api/receipt/${mine.receipt.id}`, { grocerId: third.id })).status, 200);

  // Someone else's receipt, someone else paid: I may not.
  const theirs = d.createReceipt(db, { householdId: me.household_id, store: 'Not mine', grocerId: other.id, createdBy: third.id });
  assert.equal((await api('GET', `/api/receipt/${theirs.id}`)).body.canManage, false);
  assert.equal((await api('PATCH', `/api/receipt/${theirs.id}`, { grocerId: me.id })).status, 403);
  assert.equal((await api('DELETE', `/api/receipt/${theirs.id}`)).status, 403);

  // Legacy row (created_by NULL) is grocer-only.
  const legacy = d.createReceipt(db, { householdId: me.household_id, store: 'Old', grocerId: other.id });
  assert.equal((await api('DELETE', `/api/receipt/${legacy.id}`)).status, 403);

  // Delete: review only.
  const del = d.createReceipt(db, { householdId: me.household_id, store: 'Del', grocerId: me.id, createdBy: me.id });
  const put = await api('PUT', `/api/receipt/${del.id}/items`, { items: [{ name: 'a', priceCents: 100 }, { name: 'b', priceCents: 100 }], knownIds: [] });
  await api('POST', `/api/receipt/${del.id}/poll`, { itemIds: [put.body.items[0].id] });
  const live = await api('DELETE', `/api/receipt/${del.id}`);
  assert.equal(live.status, 409);
  assert.match(live.body.error, /close the poll/);
  await api('POST', `/api/receipt/${del.id}/close-poll`);
  assert.deepEqual((await api('DELETE', `/api/receipt/${del.id}`)).body, { ok: true });
  assert.equal(d.receipt(db, del.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM item WHERE receipt_id = ?').get(del.id).n, 0, 'items cascaded');
});

test('B34: malformed items are a 400, not a 500', async () => {
  const { id } = await mkReceipt('B34 Mart', []);
  for (const items of [[null], ['x'], [[]], [1]]) {
    assert.equal((await api('PUT', `/api/receipt/${id}/items`, { items, knownIds: [] })).status, 400);
  }
});

test('B14: a new poll clears the previous opt-outs and voters', async () => {
  const { id, items } = await mkReceipt('B14 Mart', [{ name: 'Wine', priceCents: 3000 }, { name: 'Rice', priceCents: 500 }]);
  const ms = (await api('GET', '/api/state')).body.members;
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b14poll' WHERE id = ?").run(id);
  await voteAs(ms[1], 7014, 'b14poll', [0]);
  assert.equal(d.optOuts(db, id).length, 1);
  await api('POST', `/api/receipt/${id}/close-poll`);
  const again = await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[1].id] });
  assert.equal(again.body.optOuts.length, 0);
  assert.equal(again.body.voterIds.length, 0);
});

// ── round 1c ────────────────────────────────────────────────────────────────

test('B32 leftovers: stale screens cannot resurrect a deleted line or hit a reused id', async () => {
  const { id, items } = await mkReceipt('B32c Mart', [{ name: 'eggs', priceCents: 300 }, { name: 'milk', priceCents: 200 }]);
  const [eggs, milk] = items;
  const both = [eggs.id, milk.id];
  // A deletes eggs.
  const a = await api('PUT', `/api/receipt/${id}/items`, { items: [{ id: milk.id, name: 'milk', priceCents: 200 }], knownIds: both });
  assert.equal(a.status, 200);
  // Stale B (still shows eggs) renames milk: refused, eggs stays deleted.
  const b = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: eggs.id, name: 'eggs', priceCents: 300 }, { id: milk.id, name: 'oat milk', priceCents: 200 }], knownIds: both,
  });
  assert.equal(b.status, 409);
  assert.equal(b.body.code, 'stale');
  assert.deepEqual(d.items(db, id).map((i) => i.name), ['milk']);
  // A "rescans" (ids are reused by SQLite once freed); stale B edits by the old ids.
  d.replaceItems(db, id, [{ name: 'scanned', priceCents: 777 }]);
  const c = await api('PUT', `/api/receipt/${id}/items`, { items: [{ id: milk.id, name: 'clobber', priceCents: 1 }], knownIds: [milk.id] });
  assert.equal(c.status, 409);
  assert.equal(d.items(db, id)[0].name, 'scanned');
  assert.equal(d.items(db, id)[0].price_cents, 777);
});

test('B36: static files are never cached', async () => {
  const res = await fetch(base + '/app.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('B37: a vote that lands after the receipt is locked during the group check is dropped', async () => {
  const tg = require('./telegram.js');
  const real = tg.isInChat;
  const house = d.firstHousehold(db);
  const { id, items } = await mkReceipt('B37a Mart', [{ name: 'Wine', priceCents: 3000 }]);
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b37a' WHERE id = ?").run(id);
  db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-100', house.id);
  try {
    tg.isInChat = async () => {
      db.prepare("UPDATE receipt SET status = 'confirmed' WHERE id = ?").run(id); // lock mid-check
      return true;
    };
    await handleUpdate({ poll_answer: { poll_id: 'b37a', user: { id: 9201, first_name: 'Z' }, option_ids: [0] } });
    assert.equal(d.optOuts(db, id).length, 0);
  } finally {
    tg.isInChat = real;
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  }
});

test('B37: one user\'s vote then quick retraction apply in order', async () => {
  const tg = require('./telegram.js');
  const real = tg.isInChat;
  const house = d.firstHousehold(db);
  const { id, items } = await mkReceipt('B37b Mart', [{ name: 'Wine', priceCents: 3000 }, { name: 'Rice', priceCents: 500 }]);
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id, items[1].id] });
  db.prepare("UPDATE receipt SET telegram_poll_id = 'b37b' WHERE id = ?").run(id);
  db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-100', house.id);
  let calls = 0;
  try {
    // The first check is slow, the second fast: unserialised, the retraction would land first.
    tg.isInChat = async () => { await new Promise((r) => setTimeout(r, calls++ === 0 ? 80 : 5)); return true; };
    const ans = (option_ids) => handleUpdate({ poll_answer: { poll_id: 'b37b', user: { id: 9202, first_name: 'Y' }, option_ids } });
    await Promise.all([ans([0, 1]), ans([])]);
    assert.equal(d.optOuts(db, id).length, 0, 'the retraction (sent last) wins');
  } finally {
    tg.isInChat = real;
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  }
});

test('B38: odd quantity / aiGuess / name values are coerced, not a 500', async () => {
  const { id } = await mkReceipt('B38 Mart', []);
  const put = await api('PUT', `/api/receipt/${id}/items`, {
    knownIds: [],
    items: [
      { name: 'x'.repeat(500), priceCents: 100, quantity: { a: 1 }, aiGuess: ['arr'] },
      { name: 'ok', priceCents: 100, quantity: 2.5, aiGuess: '  ' + 'g'.repeat(300) },
      { name: { o: 1 }, priceCents: 100, quantity: 'Infinity' },
    ],
  });
  assert.equal(put.status, 200);
  const [a, b, c] = put.body.items;
  assert.equal(a.name.length, 200);
  assert.equal(a.quantity, null);
  assert.equal(a.ai_guess, null);
  assert.equal(b.quantity, 2.5);
  assert.equal(b.ai_guess.length, 200);
  assert.equal(c.quantity, null);
  assert.equal((await api('GET', '/api/state')).status, 200);
});
