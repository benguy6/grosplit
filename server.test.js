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
  db.prepare("UPDATE poll SET telegram_poll_id = 'testpoll' WHERE receipt_id = ? AND part = 1").run(id);

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
  assert.equal(view.voterIds.length, 1, 'a retraction un-votes her (B-retract)');

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

test('there is no item cap: 12 items become two polls; an empty selection is refused', async () => {
  const created = await api('POST', '/api/receipt', { store: 'Target' });
  const id = created.body.receipt.id;
  const many = Array.from({ length: 12 }, (_, i) => ({ name: 'Item ' + i, priceCents: 100 + i }));
  const put = await api('PUT', `/api/receipt/${id}/items`, { items: many, knownIds: [] });

  const all = await api('POST', `/api/receipt/${id}/poll`, { itemIds: put.body.items.map((i) => i.id) });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.polls.map((p) => p.itemIds.length), [6, 6]);

  const fresh = (await api('POST', '/api/receipt', { store: 'Target 2' })).body.receipt.id;
  const empty = await api('POST', `/api/receipt/${fresh}/poll`, { itemIds: [] });
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b1poll' WHERE receipt_id = ? AND part = 1").run(id);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b2poll' WHERE receipt_id = ? AND part = 1").run(id);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b8poll' WHERE receipt_id = ? AND part = 1").run(id);
  db.prepare('UPDATE receipt SET poll_closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, id);
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
  const run = (extra) => spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
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
    setTimeout(() => resolve(buf), 20000);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b29poll' WHERE receipt_id = ? AND part = 1").run(id);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b14poll' WHERE receipt_id = ? AND part = 1").run(id);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b37a' WHERE receipt_id = ? AND part = 1").run(id);
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
  db.prepare("UPDATE poll SET telegram_poll_id = 'b37b' WHERE receipt_id = ? AND part = 1").run(id);
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

// ── F1: several linked polls per receipt ────────────────────────────────────

const tgMod = require('./telegram.js');
const { auth } = require('./server.js');
// Pretend we're live: stub Telegram, and hand out poll ids / message ids.
async function withTelegram(fn, { failAt = null } = {}) {
  const real = { s: tgMod.sendPoll, x: tgMod.stopPoll, c: tgMod.isInChat, v: tgMod.verifyInitData };
  const house = d.firstHousehold(db);
  const sent = [];
  const stopped = [];
  let n = 0;
  tgMod.sendPoll = async (_t, _c, question, options) => {
    if (failAt !== null && sent.length === failAt) throw new Error('boom');
    n++;
    const rec = { question, options, poll: { id: 'f1-' + process.hrtime.bigint() + '-' + n }, message_id: 1000 + n };
    sent.push(rec);
    return rec;
  };
  tgMod.stopPoll = async (_t, _c, mid) => { stopped.push(mid); };
  tgMod.isInChat = async () => true;
  tgMod.verifyInitData = () => ({ id: 7777 }); // the API caller, Ben, as a verified Telegram user
  db.prepare('UPDATE member SET telegram_user_id = ? WHERE id = ?').run('7777', d.members(db, house.id)[0].id);
  db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-100', house.id);
  auth.dev = false; auth.token = 'tok';
  try { return await fn({ sent, stopped }); } finally {
    auth.dev = true; auth.token = '';
    tgMod.sendPoll = real.s; tgMod.stopPoll = real.x; tgMod.isInChat = real.c; tgMod.verifyInitData = real.v;
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  }
}
// In non-DEV mode the API needs initData; the tests call the HTTP API in DEV, so flip only around Telegram calls.
// (withTelegram flips auth.dev, so API requests inside it are authenticated as a verified Telegram user.)
const manyItems = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Thing ' + i, priceCents: 100 + i }));
const answerAs = async (member, pollTid, optionIds) => {
  db.prepare('UPDATE member SET telegram_user_id = ? WHERE id = ?').run(String(8000 + member.id), member.id);
  await handleUpdate({ poll_answer: { poll_id: pollTid, user: { id: 8000 + member.id }, option_ids: optionIds } });
};

test('F1: 20 items become 3 polls of 7/7/6 with the right option->item mapping and the extra option', async () => {
  await withTelegram(async ({ sent }) => {
    const { id, items } = await mkReceipt('F1 Mart', manyItems(20));
    const res = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    assert.equal(res.status, 200);
    assert.equal(res.body.pollCount, 3);
    assert.deepEqual(res.body.polls.map((p) => p.itemIds.length), [7, 7, 6]);
    assert.deepEqual(res.body.polls.map((p) => p.part), [1, 2, 3]);
    assert.deepEqual(res.body.polls.flatMap((p) => p.itemIds), items.map((i) => i.id), 'receipt order preserved');
    assert.equal(sent.length, 3);
    assert.deepEqual(sent.map((s) => s.options.length), [8, 8, 7]);
    assert.equal(sent[0].options.at(-1), "✅ I'm in on all of these");
    assert.match(sent[1].question, /2 of 3: tick anything you're NOT in on/);
    assert.ok(sent.every((s) => s.question.length <= 300));
    const polls = d.polls(db, id);
    const mapped = d.polledItems(db, id).filter((m) => m.poll_id === polls[1].id).sort((a, b) => a.option_index - b.option_index);
    assert.deepEqual(mapped.map((m) => m.item_id), res.body.polls[1].itemIds, 'option k is the k-th item of the part');
  });
});

test('F1: 9 items stay one poll (no "k of N"), a 1-item poll has 2 options', async () => {
  await withTelegram(async ({ sent }) => {
    const nine = await mkReceipt('F1 nine', manyItems(9));
    const r9 = await api('POST', `/api/receipt/${nine.id}/poll`, { itemIds: nine.items.map((i) => i.id) });
    assert.equal(r9.body.pollCount, 1);
    assert.equal(sent[0].options.length, 10);
    assert.doesNotMatch(sent[0].question, / of 1/);
    const one = await mkReceipt('F1 one', manyItems(2));
    const r1 = await api('POST', `/api/receipt/${one.id}/poll`, { itemIds: [one.items[0].id] });
    assert.equal(r1.status, 200);
    assert.equal(sent[1].options.length, 2);
  });
});

test('F1: votes are per poll; retracting in poll 1 leaves poll 2; voterIds needs every poll', async () => {
  await withTelegram(async () => {
    const { id, items } = await mkReceipt('F1 votes', manyItems(14)); // 7 + 7
    const view = (await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) })).body;
    const [p1, p2] = d.polls(db, id);
    const aisha = (await api('GET', '/api/state')).body.members[1];
    const a2 = view.polls[1];

    await answerAs(aisha, p2.telegram_poll_id, [0, 1]);
    let v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.deepEqual(v.optOuts.map((o) => o.itemId).sort(), a2.itemIds.slice(0, 2).sort());
    assert.deepEqual(v.voteProgress, { [aisha.id]: 1 });
    assert.deepEqual(v.voterIds, [], 'one of two polls is not fully voted');

    await answerAs(aisha, p1.telegram_poll_id, [2]);
    v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.equal(v.optOuts.length, 3, 'a poll 1 vote did not touch poll 2');
    assert.deepEqual(v.voterIds, [aisha.id]);
    assert.equal(v.voteProgress[aisha.id], 2);

    await answerAs(aisha, p1.telegram_poll_id, []); // retract poll 1 only
    v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.deepEqual(v.optOuts.map((o) => o.itemId).sort(), a2.itemIds.slice(0, 2).sort(), 'poll 2 opt-outs intact');
    assert.deepEqual(v.voterIds, [], 'a retraction is not a vote');
  });
});

test('F1: "in on all of these" alone is a vote with no opt-outs; with items, the items win', async () => {
  await withTelegram(async () => {
    const { id, items } = await mkReceipt('F1 inall', manyItems(3));
    await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    const [p] = d.polls(db, id);
    const ms = (await api('GET', '/api/state')).body.members;
    await answerAs(ms[1], p.telegram_poll_id, [3]); // the extra option
    let v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.equal(v.optOuts.length, 0);
    assert.deepEqual(v.voterIds, [ms[1].id]);
    await answerAs(ms[2], p.telegram_poll_id, [0, 3]);
    v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.deepEqual(v.optOuts.map((o) => [o.itemId, o.memberId]), [[items[0].id, ms[2].id]]);
  });
});

test('F1: if sending poll 2 fails, poll 1 is stopped, nothing is saved, 502', async () => {
  await withTelegram(async ({ sent, stopped }) => {
    const { id, items } = await mkReceipt('F1 fail', manyItems(14));
    const res = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    assert.equal(res.status, 502);
    assert.equal(sent.length, 1);
    assert.deepEqual(stopped, [sent[0].message_id]);
    assert.equal(d.polls(db, id).length, 0);
    assert.equal(d.polledItems(db, id).length, 0);
    assert.equal(d.receipt(db, id).status, 'review');
  }, { failAt: 1 });
});

test('F1: closing stops every Telegram poll of the receipt', async () => {
  await withTelegram(async ({ sent, stopped }) => {
    const { id, items } = await mkReceipt('F1 close', manyItems(20));
    await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    const closed = await api('POST', `/api/receipt/${id}/close-poll`);
    assert.equal(closed.body.receipt.status, 'review');
    assert.equal(stopped.length, 3);
    assert.deepEqual([...stopped].sort(), sent.map((s) => s.message_id).sort());
  });
});

test('F1 migration: a single-poll database moves to the poll table, idempotently', () => {
  const p = path.join(os.tmpdir(), 'grosplit-f1mig-' + process.pid + '.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(p);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE household (id INTEGER PRIMARY KEY, name TEXT NOT NULL, telegram_chat_id TEXT UNIQUE,
      poll_window_hours INTEGER NOT NULL DEFAULT 4, auto_flag_staples INTEGER NOT NULL DEFAULT 1,
      round_to_cent INTEGER NOT NULL DEFAULT 1, currency TEXT NOT NULL DEFAULT '$');
    CREATE TABLE member (id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
      name TEXT NOT NULL, initial TEXT NOT NULL, avatar_color TEXT NOT NULL, telegram_handle TEXT, telegram_user_id TEXT UNIQUE);
    CREATE TABLE receipt (id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
      store TEXT NOT NULL, created_at INTEGER NOT NULL, grocer_id INTEGER NOT NULL REFERENCES member(id),
      tax_cents INTEGER NOT NULL DEFAULT 0, tax_enabled INTEGER NOT NULL DEFAULT 1, tax_mode TEXT NOT NULL DEFAULT 'pro',
      status TEXT NOT NULL DEFAULT 'review', telegram_poll_id TEXT, poll_message_id INTEGER, poll_closes_at INTEGER,
      printed_total_cents INTEGER);
    CREATE TABLE item (id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
      name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity REAL, ai_flagged INTEGER NOT NULL DEFAULT 0,
      ai_guess TEXT, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE polled_item (receipt_id INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE, option_index INTEGER NOT NULL,
      PRIMARY KEY (receipt_id, item_id));
    CREATE TABLE opt_out (receipt_id INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY (receipt_id, item_id, member_id));
    CREATE TABLE poll_voter (receipt_id INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE, voted_at INTEGER NOT NULL,
      PRIMARY KEY (receipt_id, member_id));
    INSERT INTO household (id, name) VALUES (1, 'h');
    INSERT INTO member VALUES (1, 1, 'A', 'A', '#000', NULL, NULL), (2, 1, 'B', 'B', '#111', NULL, NULL);
    INSERT INTO receipt (id, household_id, store, created_at, grocer_id, status, telegram_poll_id, poll_message_id, poll_closes_at)
      VALUES (1, 1, 'polled', 0, 1, 'polling', 'oldpoll', 55, 9999999999), (2, 1, 'plain', 0, 1, 'review', NULL, NULL, NULL);
    INSERT INTO item (id, receipt_id, name, price_cents) VALUES (10, 1, 'a', 100), (11, 1, 'b', 200), (12, 2, 'c', 300);
    INSERT INTO polled_item VALUES (1, 10, 0), (1, 11, 1);
    INSERT INTO opt_out VALUES (1, 10, 2);
    INSERT INTO poll_voter VALUES (1, 2, 123);
  `);
  old.close();
  for (let pass = 0; pass < 2; pass++) { // the second open proves idempotence
    const mig = d.open(p);
    const polls = mig.prepare('SELECT * FROM poll').all();
    assert.equal(polls.length, 1, 'only the receipt that had a poll');
    assert.equal(polls[0].receipt_id, 1);
    assert.equal(polls[0].part, 1);
    assert.equal(polls[0].telegram_poll_id, 'oldpoll');
    assert.equal(polls[0].message_id, 55);
    assert.deepEqual(mig.prepare('SELECT poll_id FROM polled_item').all().map((r) => r.poll_id), [polls[0].id, polls[0].id]);
    assert.deepEqual(mig.prepare('SELECT poll_id, member_id, voted_at FROM poll_voter').all().map((r) => ({ ...r })),
      [{ poll_id: polls[0].id, member_id: 2, voted_at: 123 }]);
    assert.equal(mig.prepare('SELECT COUNT(*) n FROM opt_out').get().n, 1, 'opt-outs untouched');
    mig.close();
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true, maxRetries: 5, retryDelay: 100 });
});

// ── F1 follow-ups ───────────────────────────────────────────────────────────

test('POST /poll: two concurrent requests cannot both send (second gets 409, nothing orphaned)', async () => {
  await withTelegram(async ({ sent }) => {
    const slow = tgMod.sendPoll;
    tgMod.sendPoll = async (...a) => { await new Promise((r) => setTimeout(r, 60)); return slow(...a); };
    const { id, items } = await mkReceipt('Race Mart', manyItems(3));
    const body = { itemIds: items.map((i) => i.id) };
    const [a, b] = await Promise.all([api('POST', `/api/receipt/${id}/poll`, body), api('POST', `/api/receipt/${id}/poll`, body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(sent.length, 1, 'only one set was sent');
    assert.equal(d.polls(db, id)[0].message_id, sent[0].message_id, 'and it is the tracked one');
  });
});

test('POST /poll: a failure after sending (item deleted mid-send) stops the polls and frees the receipt', async () => {
  await withTelegram(async ({ sent, stopped }) => {
    const { id, items } = await mkReceipt('Mid Mart', manyItems(3));
    const real = tgMod.sendPoll;
    tgMod.sendPoll = async (...a) => {
      const r = await real(...a);
      db.prepare('DELETE FROM item WHERE id = ?').run(items[0].id); // FK error when saving the mapping
      return r;
    };
    const res = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    assert.equal(res.status, 500);
    assert.deepEqual(stopped, sent.map((s) => s.message_id));
    assert.equal(d.receipt(db, id).status, 'review');
    assert.equal(d.polls(db, id).length, 0);
  });
});

test("a stale 'posting' receipt is handed back to review", async () => {
  const { id } = await mkReceipt('Stuck Mart', manyItems(2));
  db.prepare("UPDATE receipt SET status = 'posting', poll_closes_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 300, id);
  await api('GET', '/api/state');
  assert.equal(d.receipt(db, id).status, 'review');
  assert.equal(d.receipt(db, id).poll_closes_at, null);
});

test('more than 15 polls is a friendly 400', async () => {
  const { id, items } = await mkReceipt('Huge Mart', manyItems(136)); // 136 / 9 -> 16 polls
  const res = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /more than 15 polls/);
  assert.equal(d.receipt(db, id).status, 'review', 'not claimed');
});

test('retraction (empty answer) deletes the poll_voter row; an answer re-adds it', async () => {
  await withTelegram(async () => {
    const { id, items } = await mkReceipt('Retract Mart', manyItems(2));
    await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    const [p] = d.polls(db, id);
    const aisha = (await api('GET', '/api/state')).body.members[1];
    await answerAs(aisha, p.telegram_poll_id, [0]);
    assert.equal(d.voters(db, id).length, 1);
    await answerAs(aisha, p.telegram_poll_id, []);
    assert.equal(d.voters(db, id).length, 0);
    assert.equal(d.optOuts(db, id).length, 0);
    await answerAs(aisha, p.telegram_poll_id, [2]);
    assert.equal(d.voters(db, id).length, 1);
  });
});

test('refuses to start off Fly without DATABASE_PATH (cannot silently open the live db)', () => {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: 'x:y', PORT: '0' };
  delete env.DEV; delete env.DATABASE_PATH; delete env.FLY_APP_NAME;
  const r = spawnSync(process.execPath, ['server.js'], { cwd: __dirname, env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DATABASE_PATH/);
});

test('sign-in rejection logging is limited to one line per reason per minute', () => {
  const { warnOncePerMinute } = require('./server.js');
  const real = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(m);
  try {
    for (let i = 0; i < 5; i++) warnOncePerMinute('sign-in rejected: test-reason-A');
    warnOncePerMinute('sign-in rejected: test-reason-B');
  } finally { console.warn = real; }
  assert.deepEqual(lines, ['sign-in rejected: test-reason-A', 'sign-in rejected: test-reason-B']);
});

// ── send-window gate fixes ──────────────────────────────────────────────────

test('B48: confirm / close are refused while posting, and the commit cannot overwrite a lock', async () => {
  await withTelegram(async ({ stopped }) => {
    const { id, items } = await mkReceipt('B48 Mart', manyItems(3));
    const real = tgMod.sendPoll;
    let during;
    tgMod.sendPoll = async (...a) => {
      const r = await real(...a);
      during = [await api('POST', `/api/receipt/${id}/confirm`), await api('POST', `/api/receipt/${id}/close-poll`)];
      return r;
    };
    const ok1 = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    assert.equal(ok1.status, 200);
    assert.deepEqual(during.map((x) => x.status), [409, 409]);
    assert.equal(d.receipt(db, id).status, 'polling');

    // Even if something did lock it mid-send, the commit must not overwrite that.
    const two = await mkReceipt('B48b Mart', manyItems(3));
    tgMod.sendPoll = async (...a) => {
      const r = await real(...a);
      db.prepare("UPDATE receipt SET status = 'confirmed' WHERE id = ?").run(two.id);
      return r;
    };
    const res = await api('POST', `/api/receipt/${two.id}/poll`, { itemIds: two.items.map((i) => i.id) });
    assert.equal(res.status, 409);
    assert.equal(d.receipt(db, two.id).status, 'confirmed', 'lock not undone');
    assert.equal(stopped.length, 1, 'the poll that went out was stopped');
  });
});

test('B49: a vote on poll 1 while poll 2 is still sending is kept; a failure removes everything', async () => {
  await withTelegram(async ({ sent }) => {
    const { id, items } = await mkReceipt('B49 Mart', manyItems(14));
    const aisha = (await api('GET', '/api/state')).body.members[1];
    const real = tgMod.sendPoll;
    tgMod.sendPoll = async (...a) => {
      if (sent.length === 1) { // poll 1 is out, poll 2 is about to be sent
        await answerAs(aisha, sent[0].poll.id, [0]);
      }
      return real(...a);
    };
    const res = await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    assert.equal(res.status, 200);
    assert.equal(res.body.optOuts.length, 1, 'early vote survived');
    assert.deepEqual(res.body.voteProgress, { [aisha.id]: 1 });

    // Failure after an early vote: opt-outs, voters and poll rows are all gone.
    const two = await mkReceipt('B49b Mart', manyItems(14));
    let n = 0;
    tgMod.sendPoll = async (...a) => {
      if (n++ === 1) {
        await answerAs(aisha, sent.at(-1).poll.id, [0]);
        throw new Error('boom');
      }
      return real(...a);
    };
    const bad = await api('POST', `/api/receipt/${two.id}/poll`, { itemIds: two.items.map((i) => i.id) });
    assert.equal(bad.status, 502);
    assert.equal(d.optOuts(db, two.id).length, 0);
    assert.equal(d.voters(db, two.id).length, 0);
    assert.equal(d.polls(db, two.id).length, 0);
    assert.equal(d.receipt(db, two.id).status, 'review');
  });
});

test('B50: Telegram calls carry a timeout signal; a stale posting receipt has its polls stopped and deleted', async () => {
  const realFetch = globalThis.fetch;
  let init;
  globalThis.fetch = async (_u, i) => { init = i; return { json: async () => ({ ok: true, result: 1 }) }; };
  try { await tgMod.call('t', 'getMe'); } finally { globalThis.fetch = realFetch; }
  assert.ok(init.signal instanceof AbortSignal);

  await withTelegram(async ({ stopped }) => {
    const { id } = await mkReceipt('Stale Mart', manyItems(2));
    db.prepare('INSERT INTO poll (receipt_id, part, telegram_poll_id, message_id) VALUES (?, 1, ?, ?)').run(id, 'stale-tid', 4242);
    db.prepare("UPDATE receipt SET status = 'posting', poll_closes_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 400, id);
    await api('GET', '/api/state');
    assert.equal(d.receipt(db, id).status, 'review');
    assert.equal(d.polls(db, id).length, 0);
    assert.deepEqual(stopped, [4242]);
  });
});

// ── group setup: logging, replies, /start ───────────────────────────────────

const startMsg = (chatId, title, text = '/start@gro_split_bot') => ({
  update_id: 1,
  message: { chat: { id: chatId, type: 'supergroup', title }, from: { id: 5, first_name: 'Secret Name' }, text },
});

test('groups: /start links the household and replies; /start again reports; a second group is told once', async () => {
  const house = d.firstHousehold(db);
  const was = { name: house.name, chat: house.telegram_chat_id };
  const replies = [];
  const logs = [];
  const real = { m: tgMod.sendMessage, l: console.log };
  tgMod.sendMessage = async (_t, chat, text) => { replies.push([chat, text]); return { message_id: 1 }; };
  console.log = (...a) => logs.push(a.join(' '));
  auth.dev = false; auth.token = 'tok';
  db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
  try {
    await handleUpdate(startMsg(-500, 'Watertown Family'));
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-500');
    assert.deepEqual(replies.at(-1), [-500, '✅ GroSplit is set up for Watertown Family. Everyone tap the button above once to join.']);

    await handleUpdate(startMsg(-500, 'Watertown Family'));
    const n = d.members(db, house.id).length;
    assert.match(replies.at(-1)[1], new RegExp('set up here — ' + n + ' housemates have joined'));

    const before = replies.length;
    await handleUpdate(startMsg(-501, 'Other Group'));
    assert.deepEqual(replies.at(-1), [-501, "I'm already set up for another group."]);
    await handleUpdate(startMsg(-501, 'Other Group'));
    assert.equal(replies.length, before + 1, 'told only once');
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-500', 'not re-linked');

    assert.ok(logs.includes('update: message from supergroup "Watertown Family"'), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('Secret Name'), 'no names in logs');
    assert.ok(!logs.join('\n').includes('/start'), 'no message text in logs');
  } finally {
    tgMod.sendMessage = real.m; console.log = real.l;
    auth.dev = true; auth.token = '';
    db.prepare('UPDATE household SET telegram_chat_id = ?, name = ? WHERE id = ?').run(was.chat, was.name, house.id);
  }
});

test('groups: on an empty database /start@bot in a group creates the household and replies', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const server = require('./server.js'); const tg = require('./telegram.js');
    const replies = []; tg.sendMessage = async (_t, c, t) => { replies.push([c, t]); return { message_id: 1 }; };
    server.auth.dev = false; server.auth.token = 'x:y';
    (async () => {
      console.log = () => {};
      await server.handleUpdate({ update_id: 1, message: { chat: { id: -9, type: 'supergroup', title: 'Watertown Family' }, text: '/start@gro_split_bot' } });
      const h = server.db.prepare('SELECT * FROM household').all();
      process.stdout.write(JSON.stringify({ h, replies }));
      process.exit(0);
    })();`;
  const db2 = path.join(os.tmpdir(), 'grosplit-grp-' + process.pid + '.db');
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: 'x:y', DATABASE_PATH: db2 };
  delete env.DEV; delete env.FLY_APP_NAME;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8', timeout: 30000 });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db2 + suffix, { force: true, maxRetries: 5, retryDelay: 100 });
  const out = JSON.parse(r.stdout);
  assert.equal(out.h.length, 1);
  assert.equal(out.h[0].name, 'Watertown Family');
  assert.equal(out.h[0].telegram_chat_id, '-9');
  assert.deepEqual(out.replies, [[-9, '✅ GroSplit is set up for Watertown Family. Everyone tap the button above once to join.']]);
});

test('the long-poll loop asks Telegram for message updates (commands reach handleUpdate)', () => {
  assert.ok(require('node:fs').readFileSync(path.join(__dirname, 'server.js'), 'utf8')
    .includes("const POLL_UPDATES = ['message', 'poll_answer', 'my_chat_member']"));
});

// ── group linking gate fixes ────────────────────────────────────────────────

async function withGroupStubs(fn) {
  const house = d.firstHousehold(db);
  const was = { name: house.name, chat: house.telegram_chat_id };
  const replies = [];
  const logs = [];
  const real = { m: tgMod.sendMessage, l: console.log, c: tgMod.getChatMember, p: tgMod.pinChatMessage };
  tgMod.sendMessage = async (_t, chat, text, extra) => { replies.push({ chat, text, button: !!(extra && extra.reply_markup) }); return { message_id: 1 }; };
  tgMod.getChatMember = async () => ({ status: 'member' });
  tgMod.pinChatMessage = async () => {};
  console.log = (...a) => logs.push(a.join(' '));
  auth.dev = false; auth.token = 'tok';
  try { return await fn({ house, replies, logs }); } finally {
    tgMod.sendMessage = real.m; tgMod.getChatMember = real.c; tgMod.pinChatMessage = real.p; console.log = real.l;
    auth.dev = true; auth.token = '';
    delete process.env.TELEGRAM_OWNER_ID;
    require('./server.js')._setBotForTests('', null);
    db.prepare('UPDATE household SET telegram_chat_id = ?, name = ? WHERE id = ?').run(was.chat, was.name, house.id);
  }
}
const grp = (id, type = 'supergroup', title = 'G') => ({ id, type, title });
const added = (chat, fromId) => ({
  update_id: 1,
  my_chat_member: { chat, from: { id: fromId }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } },
});

test('migration: a basic group becoming a supergroup keeps the household linked', async () => {
  await withGroupStubs(async ({ house, replies }) => {
    db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-600', house.id);
    await handleUpdate({ message: { chat: grp(-600, 'group'), migrate_to_chat_id: -1006 } });
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-1006');
    await handleUpdate({ message: { chat: grp(-1006), text: '/start' } });
    assert.match(replies.at(-1).text, /set up here/, 'not told "another group"');

    // The other direction (the supergroup's own migrate_from message).
    db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-700', house.id);
    await handleUpdate({ message: { chat: grp(-1007), migrate_from_chat_id: -700 } });
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-1007');
    // A migration of some other chat changes nothing.
    await handleUpdate({ message: { chat: grp(-800, 'group'), migrate_to_chat_id: -1008 } });
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-1007');
  });
});

test('TELEGRAM_OWNER_ID: only the owner can create or link the household', async () => {
  await withGroupStubs(async ({ house, replies }) => {
    process.env.TELEGRAM_OWNER_ID = '42';
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
    await handleUpdate({ message: { chat: grp(-900), from: { id: 7 }, text: '/start' } });
    await handleUpdate(added(grp(-900), 7));
    assert.equal(d.firstHousehold(db).telegram_chat_id, null, 'a stranger cannot claim it');
    assert.equal(replies.length, 0, 'and gets no reply');
    await handleUpdate(added(grp(-900), 42));
    assert.equal(d.firstHousehold(db).telegram_chat_id, '-900');
    assert.ok(replies.length >= 1);
  });
});

test('a stranger group is told once and never greeted or pinned, even when re-added', async () => {
  await withGroupStubs(async ({ house, replies }) => {
    require('./server.js')._setBotForTests('gro_test_bot', 99);
    db.prepare('UPDATE household SET telegram_chat_id = ? WHERE id = ?').run('-500', house.id);
    for (let i = 0; i < 3; i++) await handleUpdate(added(grp(-5001), 1));
    await handleUpdate({ message: { chat: grp(-5001), from: { id: 1 }, text: '/start' } });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "I'm already set up for another group.");
    assert.equal(replies.filter((r) => r.button).length, 0, 'no greeting button');
  });
});

test('linking via /start also posts the greeting button before the setup reply', async () => {
  await withGroupStubs(async ({ house, replies }) => {
    require('./server.js')._setBotForTests('gro_test_bot', 99);
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
    await handleUpdate({ message: { chat: grp(-950, 'supergroup', 'Home'), from: { id: 1 }, text: '/start' } });
    assert.equal(replies[0].button, true, 'greeting with the button');
    assert.match(replies[1].text, /set up for Home/);
  });
});

test('group titles are quoted in logs so they cannot forge lines', async () => {
  await withGroupStubs(async ({ logs }) => {
    await handleUpdate({ message: { chat: grp(-960, 'supergroup', 'evil\nupdate: fake\u001b[31m'), text: 'hi' } });
    const line = logs.find((l) => l.startsWith('update: message from supergroup'));
    assert.ok(line && !line.includes('\n') && !line.includes('\u001b'), line);
  });
});

test('F2: the view carries item_code and lookupsPending; PUT keeps the code when a client omits it', async () => {
  const { id, items } = await mkReceipt('F2 Mart', [{ name: 'KS U/S QTRS', priceCents: 1299, itemCode: '1234567' }]);
  assert.equal(items[0].item_code, '1234567');
  const put = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: items[0].id, name: 'Butter', priceCents: 1299 }], knownIds: [items[0].id],
  });
  assert.equal(put.body.items[0].item_code, '1234567', 'older client without itemCode keeps it');
  assert.equal(put.body.lookupsPending, 0);
});

// ── F2 follow-ups ───────────────────────────────────────────────────────────

test('B63: a hand-made rename drops that item\'s cached label; unchanged or accepted-guess saves keep it', async () => {
  const { id, items } = await mkReceipt('Costco Wholesale', [{ name: 'KS U/S QTRS', priceCents: 1299, itemCode: '4242' }]);
  db.prepare('UPDATE item SET ai_guess = ? WHERE id = ?').run('Kirkland unsalted butter', items[0].id);
  db.prepare('INSERT OR REPLACE INTO product_lookup VALUES (?, ?, ?, ?, ?)').run('costco', '4242', 'Kirkland unsalted butter', 'web', 1);
  const has = () => !!db.prepare("SELECT 1 FROM product_lookup WHERE store_key = 'costco' AND item_code = '4242'").get();
  const save = (name) => api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: items[0].id, name, priceCents: 1299, aiGuess: 'Kirkland unsalted butter' }], knownIds: [items[0].id],
  });
  await save('KS U/S QTRS'); // untouched
  assert.equal(has(), true);
  await save('Kirkland unsalted butter'); // they accepted our guess
  assert.equal(has(), true);
  await save('Plugra butter'); // their own correction
  assert.equal(has(), false);
});

test('B61b: the bot being removed from a group never creates, links or greets', async () => {
  await withGroupStubs(async ({ house, replies }) => {
    process.env.TELEGRAM_OWNER_ID = '42';
    require('./server.js')._setBotForTests('gro_test_bot', 99);
    db.prepare('UPDATE household SET telegram_chat_id = NULL WHERE id = ?').run(house.id);
    await handleUpdate({
      my_chat_member: { chat: grp(-970), from: { id: 42 }, old_chat_member: { status: 'member' }, new_chat_member: { status: 'left' } },
    });
    await handleUpdate({
      my_chat_member: { chat: grp(-970), from: { id: 42 }, old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } },
    });
    assert.equal(d.firstHousehold(db).telegram_chat_id, null);
    assert.equal(replies.length, 0);
  });
});

test('B64: after delete-highest + add, a stale PUT carrying the old id gets 409 and nothing is overwritten', async () => {
  const { id, items } = await mkReceipt('B64 Mart', [{ name: 'eggs', priceCents: 650 }, { name: 'milk', priceCents: 200 }]);
  const [eggs, milk] = items;
  // A deletes the highest line (milk) and adds steak.
  const a = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: eggs.id, name: 'eggs', priceCents: 650 }], knownIds: [eggs.id, milk.id],
  });
  assert.equal(a.status, 200);
  const a2 = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: eggs.id, name: 'eggs', priceCents: 650 }, { name: 'steak', priceCents: 1999 }], knownIds: [eggs.id],
  });
  const steak = a2.body.items.find((i) => i.name === 'steak');
  assert.notEqual(steak.id, milk.id, 'the freed id is not reused');
  // B's sheet was opened before all that: it still shows milk (old id) and edits it.
  const b = await api('PUT', `/api/receipt/${id}/items`, {
    items: [{ id: eggs.id, name: 'eggs', priceCents: 650 }, { id: milk.id, name: 'milk (2)', priceCents: 250 }], knownIds: [eggs.id, milk.id],
  });
  assert.equal(b.status, 409);
  assert.equal(d.items(db, id).find((i) => i.id === steak.id).name, 'steak');
});

test('poll close posts ONE message to the group (deadline, early close, confirm), none in DEV; state rows carry pollCount', async () => {
  const msgs = [];
  const real = tgMod.sendMessage;
  tgMod.sendMessage = async (_t, chat, text) => { msgs.push([chat, text]); return { message_id: 1 }; };
  try {
    await withTelegram(async () => {
      const ms = (await api('GET', '/api/state')).body.members;
      const { id, items } = await mkReceipt('Close Mart', manyItems(2));
      await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
      const [p] = d.polls(db, id);
      await answerAs(ms[1], p.telegram_poll_id, [0]);
      let st = (await api('GET', '/api/state')).body.receipts.find((r) => r.id === id);
      assert.equal(st.pollCount, 1);
      assert.equal(st.votedCount, 1);

      // early close, twice: one message
      await api('POST', `/api/receipt/${id}/close-poll`);
      await api('POST', `/api/receipt/${id}/close-poll`);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0][0], '-100');
      assert.equal(msgs[0][1], `🗳 Poll closed for Close Mart. 1 of ${ms.length} voted. ${ms[0].name}, the split is ready to lock.`);

      // deadline: swept on the next request, once
      const two = await mkReceipt('Deadline Mart', manyItems(2));
      await api('POST', `/api/receipt/${two.id}/poll`, { itemIds: two.items.map((i) => i.id) });
      db.prepare('UPDATE receipt SET poll_closes_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, two.id);
      await api('GET', '/api/state');
      await api('GET', '/api/state');
      assert.equal(msgs.filter((m) => /Deadline Mart/.test(m[1])).length, 1);

      // confirm while polling
      const three = await mkReceipt('Confirm Mart', manyItems(2));
      await api('POST', `/api/receipt/${three.id}/poll`, { itemIds: three.items.map((i) => i.id) });
      await api('POST', `/api/receipt/${three.id}/confirm`);
      assert.equal(msgs.filter((m) => /Confirm Mart/.test(m[1])).length, 1);
    });
    // DEV: nothing is sent.
    const before = msgs.length;
    const dev = await mkReceipt('Dev Mart', manyItems(2));
    await api('POST', `/api/receipt/${dev.id}/poll`, { itemIds: dev.items.map((i) => i.id) });
    await api('POST', `/api/receipt/${dev.id}/close-poll`);
    assert.equal(msgs.length, before);
  } finally { tgMod.sendMessage = real; }
});

// ── F3: the grocer's answers count ──────────────────────────────────────────

test('F3: the grocer can vote; their opt-outs count, and they count as voted', async () => {
  await withTelegram(async () => {
    const { id, items } = await mkReceipt('F3 Mart', [{ name: 'Wine', priceCents: 3000 }, { name: 'Rice', priceCents: 600 }]);
    await api('POST', `/api/receipt/${id}/poll`, { itemIds: items.map((i) => i.id) });
    const [p] = d.polls(db, id);
    const ms = (await api('GET', '/api/state')).body.members;
    const grocer = ms[0]; // Ben created the receipt and is its grocer
    const before = (await api('GET', `/api/receipt/${id}`)).body;
    await answerAs(grocer, p.telegram_poll_id, [0]); // out of the wine
    const v = (await api('GET', `/api/receipt/${id}`)).body;
    assert.deepEqual(v.optOuts.map((o) => [o.itemId, o.memberId]), [[items[0].id, grocer.id]]);
    assert.deepEqual(v.voterIds, [grocer.id]);
    assert.equal(v.voteProgress[grocer.id], 1);
    assert.ok(v.split.shares[grocer.id].cents < before.split.shares[grocer.id].cents, 'their share dropped');
    assert.equal(Object.values(v.split.shares).reduce((s, x) => s + x.cents, 0), v.split.totalCents);
    assert.equal(v.split.totalCents, 3600, 'the grocer still pays it all');
  });
});

test('F3: a receipt locked before the change keeps its frozen numbers', async () => {
  const { id, items } = await mkReceipt('Legacy Mart', [{ name: 'Wine', priceCents: 3000 }, { name: 'Rice', priceCents: 600 }]);
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  const r = d.receipt(db, id);
  // Under the old rule the grocer's opt-out was ignored when this receipt was locked.
  const legacy = d.freezeSplit(db, id); // no grocer opt-out yet: the old numbers
  db.prepare('INSERT INTO opt_out (receipt_id, item_id, member_id) VALUES (?, ?, ?)').run(id, items[0].id, r.grocer_id);
  const live = d.computeReceiptSplit(db, d.receipt(db, id), d.members(db, r.household_id));
  assert.notDeepEqual(live, legacy.split, 'a fresh recompute would now differ');
  db.prepare("UPDATE receipt SET status = 'confirmed' WHERE id = ?").run(id);
  const v = (await api('GET', `/api/receipt/${id}`)).body;
  assert.deepEqual(v.split, legacy.split);
});

// ── F5: hand-edited opt-outs ────────────────────────────────────────────────

test('F5: PUT optouts replaces one member\'s set, on any line, leaving others and poll_voter alone', async () => {
  const { id, items } = await mkReceipt('F5 Mart', [
    { name: 'a', priceCents: 600 }, { name: 'b', priceCents: 600 }, { name: 'c', priceCents: 600 },
  ]);
  const ms = (await api('GET', '/api/state')).body.members;
  const [a, b, c] = items;
  const put = (memberId, body) => api('PUT', `/api/receipt/${id}/optouts/${memberId}`, body);
  const base = (await api('GET', `/api/receipt/${id}`)).body;

  let r = await put(ms[1].id, { itemIds: [a.id, b.id, b.id] }); // dedupes; none of these were polled
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.optOuts.map((o) => [o.itemId, o.memberId]).sort(), [[a.id, ms[1].id], [b.id, ms[1].id]].sort());
  assert.ok(r.body.split.shares[ms[1].id].cents < base.split.shares[ms[1].id].cents, 'a non-polled opt-out reduces their share');
  assert.equal(Object.values(r.body.split.shares).reduce((s, x) => s + x.cents, 0), r.body.split.totalCents, 'still sums');
  assert.deepEqual(r.body.voterIds, [], 'not a poll answer');

  await put(ms[2].id, { itemIds: [c.id] });
  r = await put(ms[1].id, { itemIds: [b.id] }); // replaces: a dropped
  assert.deepEqual(r.body.optOuts.map((o) => [o.itemId, o.memberId]).sort(),
    [[b.id, ms[1].id], [c.id, ms[2].id]].sort(), 'other members untouched');
  r = await put(ms[1].id, { itemIds: [] }); // empty = in on everything
  assert.deepEqual(r.body.optOuts.map((o) => o.memberId), [ms[2].id]);

  // validation
  assert.equal((await put(ms[1].id, { itemIds: [999999] })).status, 400, 'foreign item');
  assert.equal((await put(ms[1].id, { itemIds: 'x' })).status, 400);
  assert.equal((await put(999999, { itemIds: [] })).status, 404, 'unknown member');
  const stranger = d.addMember(db, d.createHousehold(db, { name: 'Other house' }).id, { name: 'Stranger' });
  assert.equal((await put(stranger.id, { itemIds: [] })).status, 404, 'member of another household');
  // stale guard
  const stale = await put(ms[1].id, { itemIds: [a.id], knownIds: [a.id, b.id] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  assert.equal((await put(ms[1].id, { itemIds: [a.id], knownIds: [a.id, b.id, c.id] })).status, 200);
});

test('F5: refused while a poll is live and after lock; a frozen split is unaffected', async () => {
  const { id, items } = await mkReceipt('F5b Mart', [{ name: 'a', priceCents: 600 }, { name: 'b', priceCents: 400 }]);
  const ms = (await api('GET', '/api/state')).body.members;
  const put = () => api('PUT', `/api/receipt/${id}/optouts/${ms[1].id}`, { itemIds: [items[0].id] });
  await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  const live = await put();
  assert.equal(live.status, 409);
  assert.match(live.body.error, /close the poll first/);
  await api('POST', `/api/receipt/${id}/close-poll`);
  const locked = (await api('POST', `/api/receipt/${id}/confirm`)).body;
  const late = await put();
  assert.equal(late.status, 409);
  assert.match(late.body.error, /locked/);
  assert.deepEqual((await api('GET', `/api/receipt/${id}`)).body.split, locked.split);
  assert.equal(d.optOuts(db, id).length, 0);
});

test('F5: re-polling still clears ALL opt-outs, hand edits included', async () => {
  const { id, items } = await mkReceipt('F5c Mart', [{ name: 'a', priceCents: 600 }, { name: 'b', priceCents: 400 }]);
  const ms = (await api('GET', '/api/state')).body.members;
  await api('PUT', `/api/receipt/${id}/optouts/${ms[1].id}`, { itemIds: [items[1].id] });
  assert.equal(d.optOuts(db, id).length, 1);
  const again = await api('POST', `/api/receipt/${id}/poll`, { itemIds: [items[0].id] });
  assert.equal(again.body.optOuts.length, 0);
});
