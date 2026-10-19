'use strict';

// F2: item numbers -> readable labels. No network: global fetch is stubbed.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const d = require('./db.js');
const lookup = require('./lookup.js');
const { normalise } = require('./ocr.js');

const TMP = path.join(os.tmpdir(), 'grosplit-lookup-' + process.pid + '.db');
const db = d.open(TMP);
const house = d.createHousehold(db, { name: 'h' });
const ben = d.addMember(db, house.id, { name: 'Ben' });

const realFetch = globalThis.fetch;
const realLog = console.log;
after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(TMP + s, { force: true, maxRetries: 5, retryDelay: 100 });
});
beforeEach(() => { db.exec('DELETE FROM product_lookup; DELETE FROM lookup_call'); console.log = () => {}; });
afterEach(() => { console.log = realLog; });

const mk = (store, rows) => {
  const r = d.createReceipt(db, { householdId: house.id, store, grocerId: ben.id });
  d.replaceItems(db, r.id, rows);
  return r.id;
};
const line = (name, code, extra = {}) => ({ name, priceCents: 500, itemCode: code, aiFlagged: true, ...extra });
// What the model returns: a structured JSON answer in output_text.
const structuredRes = (o) => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(o) }) });
// A fake model: `decode` answers calls without tools, `web` answers the web_search call.
const routed = (decode, web) => (_n, init) => structuredRes(JSON.parse(init.body).tools ? web : decode);
const BUTTER = 'Kirkland unsalted butter, 4 sticks';
const good = routed({ label: BUTTER, confident: true, product_noun: 'butter' }, { label: BUTTER, confident: true });
const stubFetch = (fn) => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return fn(calls.length, init); };
  return calls;
};
const opts = { apiKey: 'k' };

test('normalise carries the item number as itemCode and caps the guess at 40 chars', () => {
  const out = normalise({
    items: [
      { name: 'KS U/S QTRS', price: 12.99, confidence: 0.9, suggested_name: 'Kirkland unsalted butter, 4 sticks', item_number: ' 1234 567 ' },
      { name: 'Milk', price: 3, confidence: 1, suggested_name: null, item_number: null },
      { name: 'X', price: 1, confidence: 1, suggested_name: 'y'.repeat(80) },
    ],
  });
  assert.equal(out.items[0].itemCode, '1234567');
  assert.equal(out.items[0].aiGuess, 'Kirkland unsalted butter, 4 sticks');
  assert.equal(out.items[1].itemCode, null);
  assert.equal(out.items[2].aiGuess.length, 40);
});

test('store key strips "wholesale" and punctuation', () => {
  assert.equal(lookup.storeKey('Costco Wholesale'), 'costco');
  assert.equal(lookup.storeKey("Trader Joe's"), 'trader joes');
});

test('a cache hit fills ai_guess without any network call', async () => {
  const id = mk('Costco Wholesale', [line('KS U/S QTRS', '1234567'), line('Milk', null, { aiFlagged: false })]);
  db.prepare('INSERT INTO product_lookup VALUES (?, ?, ?, ?, ?)').run('costco', '1234567', 'Kirkland unsalted butter', 'web', 1);
  const calls = stubFetch(() => { throw new Error('no network expected'); });
  const r = lookup.afterScan(db, id, opts);
  await lookup.whenIdle();
  assert.equal(calls.length, 0);
  assert.equal(r.cached, 1);
  const it = d.items(db, id)[0];
  assert.equal(it.ai_guess, 'Kirkland unsalted butter');
  assert.equal(it.ai_flagged, 1);
});

test('a flagged item with a code looks it up (decode + web) and stores the label', async () => {
  const id = mk('Costco Wholesale', [line('KS U/S QTRS', '1234567'), line('Eggs', '999', { aiFlagged: false })]);
  const calls = stubFetch(good);
  lookup.afterScan(db, id, opts);
  assert.equal(lookup.pending(id), 1, 'in flight right away');
  await lookup.whenIdle();
  assert.equal(calls.length, 2, 'one decode + one web call; the unflagged line is not looked up');
  assert.equal(calls[0].tools, undefined, 'decode has no web search');
  assert.doesNotMatch(calls[0].input, /1234567/, 'the item number is not part of the decode');
  assert.match(calls[1].input, /Costco Wholesale \(US\) item number 1234567, printed on the receipt as "KS U\/S QTRS"/);
  assert.equal(calls[1].tools[0].type, 'web_search');
  assert.equal(lookup.pending(id), 0);
  const it = d.items(db, id)[0];
  assert.equal(it.ai_guess, 'Kirkland unsalted butter, 4 sticks');
  assert.equal(it.name, 'KS U/S QTRS', 'name never changes');
  assert.equal(it.price_cents, 500, 'price never changes');
  assert.equal(db.prepare('SELECT label FROM product_lookup WHERE store_key = ? AND item_code = ?').get('costco', '1234567').label,
    'Kirkland unsalted butter, 4 sticks');
  // Second scan of the same product: served from the cache, no new call.
  const id2 = mk('Costco', [line('KS U/S QTRS', '1234567')]);
  lookup.afterScan(db, id2, opts);
  await lookup.whenIdle();
  assert.equal(calls.length, 2);
  assert.equal(d.items(db, id2)[0].ai_guess, 'Kirkland unsalted butter, 4 sticks');
});

test('"unknown" is cached (not asked again), and sets nothing', async () => {
  const id = mk('Costco', [line('???', '555')]);
  const calls = stubFetch(routed({ label: null, confident: false, product_noun: null }, { label: null, confident: false }));
  lookup.afterScan(db, id, opts);
  await lookup.whenIdle();
  assert.equal(d.items(db, id)[0].ai_guess, null);
  const n = calls.length;
  const id2 = mk('Costco', [line('???', '555')]);
  lookup.afterScan(db, id2, opts);
  await lookup.whenIdle();
  assert.equal(calls.length, n, 'not paid for twice');
});

test('at most 15 lookups per receipt, 3 at a time', async () => {
  const id = mk('Costco', Array.from({ length: 20 }, (_, i) => line('ITEM ' + i, String(1000 + i))));
  let live = 0;
  let peak = 0;
  const calls = stubFetch(async (n, init) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return good(n, init);
  });
  const r = lookup.afterScan(db, id, opts);
  assert.equal(r.sent, 15);
  assert.equal(lookup.pending(id), 15);
  await lookup.whenIdle();
  assert.equal(calls.length, 30, '15 items x (decode + web)');
  assert.equal(peak, 3);
});

test('a timeout or failure sets nothing, caches nothing, and does not crash', async () => {
  const id = mk('Costco', [line('KS U/S QTRS', '777')]);
  stubFetch(() => { throw new DOMException('timed out', 'TimeoutError'); });
  lookup.afterScan(db, id, opts);
  await lookup.whenIdle();
  assert.equal(d.items(db, id)[0].ai_guess, null);
  assert.equal(lookup.pending(id), 0);
  // Only a short-lived "failed" marker is cached, so a rescan right away doesn't retry...
  const row = db.prepare('SELECT label, source FROM product_lookup WHERE item_code = ?').get('777');
  assert.deepEqual({ ...row }, { label: null, source: 'failed' });
  const calls = stubFetch(good);
  lookup.afterScan(db, mk('Costco', [line('KS U/S QTRS', '777')]), opts);
  await lookup.whenIdle();
  assert.equal(calls.length, 0, 'no retry within the hour');
  // ...but after the hour it does.
  db.prepare("UPDATE product_lookup SET looked_up_at = looked_up_at - 4000 WHERE item_code = '777'").run();
  const again = mk('Costco', [line('KS U/S QTRS', '777')]);
  lookup.afterScan(db, again, opts);
  await lookup.whenIdle();
  assert.equal(calls.length, 2);
  assert.equal(d.items(db, again)[0].ai_guess, BUTTER);
});

test('request shapes: decode = strict schema, no tools; web = web_search + strict schema; both /v1/responses with a timeout', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return good(seen.length, init); };
  const out = await lookup.fetchLabel({ store: 'Costco', code: '30650', printed: 'KS U/S QTRS' }, opts);
  assert.deepEqual(out, { label: 'Kirkland unsalted butter, 4 sticks', source: 'web' });
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.ok(s.url.endsWith('/v1/responses'));
    assert.ok(s.init.signal instanceof AbortSignal);
    assert.equal(s.body.text.format.type, 'json_schema');
    assert.equal(s.body.text.format.strict, true);
  }
  const [dec, web] = seen.map((s) => s.body);
  assert.equal(dec.tools, undefined);
  assert.deepEqual(dec.text.format.schema.required, ['label', 'confident', 'product_noun']);
  assert.match(dec.input, /KS = Kirkland Signature, U\/S = unsalted, QTRS = quarters/);
  assert.doesNotMatch(dec.input, /30650/);
  assert.deepEqual(web.tools, [{ type: 'web_search' }]);
  assert.deepEqual(web.text.format.schema.required, ['label', 'confident']);
});

test('the web hit is only used when it agrees with the decoded printed text', async () => {
  const run = async (printed, decode, web) => {
    globalThis.fetch = routed(decode, web);
    return lookup.fetchLabel({ store: 'Costco Wholesale', code: '30650', printed }, opts);
  };
  const butter = { label: 'Kirkland unsalted butter', confident: true, product_noun: 'butter' };

  // The live failure: the search found infant formula for the number. The decoded butter wins.
  assert.deepEqual(
    await run('KS U/S QTRS', butter, { label: 'Kirkland Signature Non-GMO Infant Formula, 34 oz, 3-count', confident: true }),
    { label: 'Kirkland unsalted butter', source: 'decoded' });

  // A 41+ character label is fine now (cap is 60) and wins when it agrees with "towels".
  const towels = { label: 'Kirkland Paper Towels, 12 rolls', confident: true, product_noun: 'towels' };
  const longWeb = 'Kirkland Signature Create-A-Size Paper Towels, 12 rolls'; // 55 chars
  assert.ok(longWeb.length > 41 && longWeb.length <= 60);
  assert.deepEqual(await run('KS PPR TWL 12RL', towels, { label: longWeb, confident: true }), { label: longWeb, source: 'web' });
  assert.equal((await run('KS PPR TWL 12RL', towels, { label: 'Kirkland Paper Towels, 12 rolls', confident: true })).label.length, 31);
  // singular/plural of the noun
  assert.equal((await run('ORG BNNAS', { label: 'Organic bananas', confident: true, product_noun: 'bananas' },
    { label: 'Organic Banana, 3 lb bag', confident: true })).source, 'web');

  // Decode unsure and the web disagrees (or there is nothing to check it against): unknown.
  const unsure = { label: null, confident: false, product_noun: null };
  assert.deepEqual(await run('ZZQ XQ', unsure, { label: 'Kirkland Signature Cashews', confident: true }), { label: null, source: 'unknown' });
  assert.deepEqual(await run('KS U/S QTRS', { label: null, confident: false, product_noun: 'butter' },
    { label: 'Kirkland Signature Cashews', confident: true }), { label: null, source: 'unknown' });
  // Decode unsure but the web agrees with whatever noun the model did see: web label.
  assert.equal((await run('KS U/S QTRS', { label: null, confident: false, product_noun: 'butter' },
    { label: 'Kirkland unsalted butter', confident: true })).source, 'web');
  // Web failure with a confident decode still gives the decoded label.
  globalThis.fetch = async (_u, init) => (JSON.parse(init.body).tools
    ? { ok: false, status: 500, json: async () => ({}) } : structuredRes(butter));
  assert.deepEqual(await lookup.fetchLabel({ store: 'Costco', code: '1', printed: 'KS U/S QTRS' }, opts),
    { label: 'Kirkland unsalted butter', source: 'decoded' });
});

test('prose, sentence-like and over-long answers are unknown, never a truncated label', async () => {
  const run = async (webRes, decode = { label: null, confident: false, product_noun: 'butter' }) => {
    globalThis.fetch = async (_u, init) => (JSON.parse(init.body).tools ? webRes : structuredRes(decode));
    return (await lookup.fetchLabel({ store: 'Costco Wholesale', code: '30650', printed: 'KS U/S QTRS' }, opts)).label;
  };
  const web = (label) => structuredRes({ label, confident: true });
  assert.equal(await run({ ok: true, status: 200, json: async () => ({ output_text: 'Based on the available information, butter.' }) }), null, 'prose, not JSON');
  assert.equal(await run(web('Based on the available information, butter')), null);
  assert.equal(await run(web('Kirkland unsalted butter.')), null, 'trailing period');
  assert.equal(await run(web('The item is butter')), null);
  assert.equal(await run(web('I could not find the butter')), null);
  assert.equal(await run(web('Sorry, no butter')), null);
  assert.equal(await run(web('butter' + 'x'.repeat(60))), null, 'too long: not cut down');
  assert.equal(await run(web('KS U/S QTRS')), null, 'just the printed text again');
  assert.equal(await run(structuredRes({ label: 'Kirkland butter', confident: false })), null);
  assert.equal(await run(web('Kirkland unsalted butter, 4 sticks')), 'Kirkland unsalted butter, 4 sticks');
});

test('a junk answer is cached as unknown and sets no guess', async () => {
  const id = mk('Costco', [line('KS U/S QTRS', '30650')]);
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ output_text: 'Based on the available information, Cost' }) }));
  lookup.afterScan(db, id, opts);
  await lookup.whenIdle();
  assert.equal(d.items(db, id)[0].ai_guess, null);
  const row = db.prepare('SELECT label, source FROM product_lookup WHERE item_code = ?').get('30650');
  assert.deepEqual({ ...row }, { label: null, source: 'unknown' });
});

test('a user edit before the lookup returns is not overwritten', async () => {
  const id = mk('Costco', [line('KS U/S QTRS', '321', { aiGuess: 'old guess' }), line('KS RL', '322')]);
  const [a, b] = d.items(db, id);
  let release;
  const gate = new Promise((r) => { release = r; });
  stubFetch(async () => { await gate; return structuredRes({ label: 'Web label x', confident: true, product_noun: 'label' }); });
  lookup.afterScan(db, id, opts);
  // While the lookups are out: the user clears one guess and renames the other line.
  db.prepare('UPDATE item SET ai_guess = NULL WHERE id = ?').run(a.id);
  db.prepare("UPDATE item SET name = 'Paper towels' WHERE id = ?").run(b.id);
  release();
  await lookup.whenIdle();
  const [a2, b2] = d.items(db, id);
  assert.equal(a2.ai_guess, null, 'cleared guess stays cleared');
  assert.equal(b2.ai_guess, null, 'renamed line untouched');
  assert.equal(b2.name, 'Paper towels');
});

test('syncItems keeps item_code when a client omits it, and sets it when given', () => {
  const id = mk('Costco', [line('A', '111')]);
  const [it] = d.items(db, id);
  d.syncItems(db, id, [{ id: it.id, name: 'A2', priceCents: 500 }], [it.id]); // older client: no itemCode
  assert.equal(d.items(db, id)[0].item_code, '111');
  d.syncItems(db, id, [{ id: it.id, name: 'A2', priceCents: 500, itemCode: '222' }], [it.id]);
  assert.equal(d.items(db, id)[0].item_code, '222');
});

test('migration adds item.item_code and product_lookup to an old database, idempotently', () => {
  const p = path.join(os.tmpdir(), 'grosplit-f2mig-' + process.pid + '.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(p);
  old.exec(d.SCHEMA.replace(/,\s*item_code\s+TEXT/, '').replace(/CREATE TABLE IF NOT EXISTS product_lookup[\s\S]*?\);/, ''));
  assert.ok(!old.prepare('PRAGMA table_info(item)').all().some((c) => c.name === 'item_code'));
  old.close();
  for (let pass = 0; pass < 2; pass++) {
    const m = d.open(p);
    assert.ok(m.prepare('PRAGMA table_info(item)').all().some((c) => c.name === 'item_code'));
    assert.equal(m.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'product_lookup'").get().n, 1);
    m.close();
  }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true, maxRetries: 5, retryDelay: 100 });
});

// ── cost / safety follow-ups ────────────────────────────────────────────────

test('B61a: a code already being looked up is not paid for again by a rescan or another receipt', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = stubFetch(async (n, init) => { await gate; return good(n, init); });
  const a = mk('Costco', [line('KS U/S QTRS', '4040')]);
  lookup.afterScan(db, a, opts);
  const b = mk('Costco', [line('KS U/S QTRS', '4040')]);
  const r2 = lookup.afterScan(db, b, opts); // same store + code, first still running
  assert.equal(r2.sent, 0);
  lookup.afterScan(db, a, opts); // rescan of the same receipt
  release();
  await lookup.whenIdle();
  assert.equal(calls.length, 2, 'one lookup = decode + web, once');
  // B66: the lines that waited on it get the answer too (the other receipt, and the rescan).
  assert.equal(d.items(db, b)[0].ai_guess, BUTTER);
  assert.equal(d.items(db, a)[0].ai_guess, BUTTER);
  assert.equal(d.items(db, b)[0].name, 'KS U/S QTRS', 'name untouched');
});

test('B61b: pending counts add up across scans instead of being overwritten', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  stubFetch(async (n, init) => { await gate; return good(n, init); });
  const id = mk('Costco', [line('A', '5001'), line('B', '5002')]);
  lookup.afterScan(db, id, opts);
  assert.equal(lookup.pending(id), 2);
  d.replaceItems(db, id, [line('A', '5001'), line('B', '5002'), line('C', '5003')]);
  lookup.afterScan(db, id, opts); // only C is new
  assert.equal(lookup.pending(id), 3, 'added, not reset to 1');
  release();
  await lookup.whenIdle();
  assert.equal(lookup.pending(id), 0);
});

test('B61: the 15 cap is per receipt across rescans', async () => {
  const calls = stubFetch(good);
  const id = mk('Costco', Array.from({ length: 15 }, (_, i) => line('I' + i, String(6000 + i))));
  assert.equal(lookup.afterScan(db, id, opts).sent, 15);
  await lookup.whenIdle();
  d.replaceItems(db, id, Array.from({ length: 5 }, (_, i) => line('J' + i, String(7000 + i))));
  assert.equal(lookup.afterScan(db, id, opts).sent, 0, 'already used the receipt\'s 15');
  assert.equal(calls.length, 30);
});

test('B61d: a daily cap on paid lookups for the whole deployment', async () => {
  process.env.LOOKUP_DAILY_CAP = '4'; // = 2 lookups
  try {
    const calls = stubFetch(good);
    const id = mk('Costco', Array.from({ length: 5 }, (_, i) => line('K' + i, String(8000 + i))));
    assert.equal(lookup.afterScan(db, id, opts).sent, 2);
    await lookup.whenIdle();
    assert.equal(calls.length, 4);
    const id2 = mk('Costco', [line('Z', '8100')]);
    assert.equal(lookup.afterScan(db, id2, opts).sent, 0, 'over the cap: skipped silently');
    assert.equal(d.items(db, id2)[0].ai_guess, null);
  } finally { delete process.env.LOOKUP_DAILY_CAP; }
});

test('B63: labels with markup, links or long digit runs are rejected', () => {
  for (const bad of ['<b>Butter</b>', 'Butter {x}', 'Butter see www.x.io', 'Butter http://x.y', 'buy at shop.com', 'Butter 12345678', 'a > b'])
    assert.equal(lookup.validLabel(bad, 'KS'), null, bad);
  assert.equal(lookup.validLabel('Kirkland unsalted butter, 4 sticks', 'KS'), 'Kirkland unsalted butter, 4 sticks');
  assert.equal(lookup.validLabel('Pack of 24 bottles 500ml', 'KS'), 'Pack of 24 bottles 500ml');
});

test('B63: the background update only touches receipts still in review', async () => {
  const id = mk('Costco', [line('KS U/S QTRS', '9191')]);
  let release;
  const gate = new Promise((r) => { release = r; });
  stubFetch(async (n, init) => { await gate; return good(n, init); });
  lookup.afterScan(db, id, opts);
  db.prepare("UPDATE receipt SET status = 'confirmed' WHERE id = ?").run(id);
  release();
  await lookup.whenIdle();
  assert.equal(d.items(db, id)[0].ai_guess, null);
});

test('B62: a cache hit does not flag a line the reader was happy with', () => {
  db.prepare('INSERT INTO product_lookup VALUES (?, ?, ?, ?, ?)').run('costco', '3030', 'Kirkland butter', 'web', 1);
  const id = mk('Costco', [line('KS BUTTER', '3030', { aiFlagged: false }), line('KS U/S QTRS', '3030')]);
  lookup.afterScan(db, id, opts);
  const [plain, flagged] = d.items(db, id);
  assert.equal(plain.ai_guess, 'Kirkland butter');
  assert.equal(plain.ai_flagged, 0, 'stays unflagged');
  assert.equal(flagged.ai_flagged, 1);
});

test('B65: the daily cap counts paid CALLS, so renames and cache edits cannot hide spending', async () => {
  process.env.LOOKUP_DAILY_CAP = '4';
  try {
    stubFetch(good);
    const id = mk('Costco', [line('A', '1'), line('B', '2'), line('C', '3')]);
    assert.equal(lookup.afterScan(db, id, opts).sent, 2);
    await lookup.whenIdle();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lookup_call').get().n, 4, 'decode + web per lookup');
    db.exec('DELETE FROM product_lookup'); // what a rename does to the cache
    const id2 = mk('Costco', [line('D', '4')]);
    assert.equal(lookup.afterScan(db, id2, opts).sent, 0, 'still over budget');
    // Rows older than 2 days are pruned when a call is next recorded; older-than-24h don't count.
    db.exec('UPDATE lookup_call SET at = at - 200000');
    const id3 = mk('Costco', [line('E', '5')]);
    assert.equal(lookup.afterScan(db, id3, opts).sent, 1);
    await lookup.whenIdle();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lookup_call').get().n, 2, 'old rows pruned');
  } finally { delete process.env.LOOKUP_DAILY_CAP; }
});

test('B65: the cap is checked before each call, mid-lookup', async () => {
  process.env.LOOKUP_DAILY_CAP = '1'; // room for the decode, not the web call
  try {
    const calls = stubFetch(good);
    // budget 0 lookups at cap 1, so call fetchLabel directly with the same hook afterScan uses
    const { fetchLabel } = lookup;
    db.exec('DELETE FROM lookup_call');
    let n = 0;
    const out = await fetchLabel({ store: 'Costco', code: '1', printed: 'KS U/S QTRS' }, {
      apiKey: 'k', beforeCall: () => { if (n++ >= 1) throw new Error('cap'); },
    });
    assert.equal(calls.length, 1, 'only the decode went out');
    assert.equal(out.source, 'decoded');
  } finally { delete process.env.LOOKUP_DAILY_CAP; }
});

test('B65: LOOKUP_DAILY_CAP parsing falls back to 100 for junk, allows 0', () => {
  const was = process.env.LOOKUP_DAILY_CAP;
  try {
    for (const [v, want] of [[undefined, 100], ['', 100], ['abc', 100], ['-5', 100], ['NaN', 100], ['0', 0], ['7', 7]]) {
      if (v === undefined) delete process.env.LOOKUP_DAILY_CAP; else process.env.LOOKUP_DAILY_CAP = v;
      assert.equal(lookup.dailyCap(), want, String(v));
    }
  } finally { if (was === undefined) delete process.env.LOOKUP_DAILY_CAP; else process.env.LOOKUP_DAILY_CAP = was; }
});

test('B64: item ids are never reused (AUTOINCREMENT)', () => {
  const id = mk('Costco', [line('A', null), line('B', null)]);
  const [, b] = d.items(db, id);
  db.prepare('DELETE FROM item WHERE id = ?').run(b.id);
  d.syncItems(db, id, [...d.items(db, id).map((i) => ({ id: i.id, name: i.name, priceCents: i.price_cents })), { name: 'C', priceCents: 1 }], d.items(db, id).map((i) => i.id));
  const c = d.items(db, id).at(-1);
  assert.ok(c.id > b.id, 'the freed id is not handed out again');
});

test('B64 migration: an old (non-AUTOINCREMENT) database is rebuilt in place, keeping every row and its cascades', () => {
  const p = path.join(os.tmpdir(), 'grosplit-b64-' + process.pid + '.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(p);
  // The pre-fix shape: identical, but item.id is a plain INTEGER PRIMARY KEY.
  old.exec(d.SCHEMA.replace('id          INTEGER PRIMARY KEY AUTOINCREMENT,', 'id          INTEGER PRIMARY KEY,'));
  assert.ok(!/AUTOINCREMENT/i.test(old.prepare("SELECT sql FROM sqlite_master WHERE name = 'item'").get().sql));
  old.exec(`
    INSERT INTO household (id, name) VALUES (1, 'h');
    INSERT INTO member (id, household_id, name, initial, avatar_color) VALUES (1, 1, 'A', 'A', '#000'), (2, 1, 'B', 'B', '#111');
    INSERT INTO receipt (id, household_id, store, created_at, grocer_id, status, locked_split, poll_closes_at)
      VALUES (1, 1, 'polled', 0, 1, 'polling', NULL, 9999999999), (2, 1, 'locked', 0, 1, 'confirmed', '{"memberIds":[1,2],"split":{"subtotalCents":300,"taxCents":0,"totalCents":300,"owedCents":0,"shares":{"1":{"cents":300,"taxCents":0,"itemCount":1},"2":{"cents":0,"taxCents":0,"itemCount":0}}}}', NULL);
    INSERT INTO item (id, receipt_id, name, price_cents, item_code) VALUES (10, 1, 'a', 100, '111'), (11, 1, 'b', 200, NULL), (12, 2, 'c', 300, NULL);
    INSERT INTO poll (id, receipt_id, part, telegram_poll_id, message_id) VALUES (1, 1, 1, 'tp', 5);
    INSERT INTO polled_item (receipt_id, item_id, option_index, poll_id) VALUES (1, 10, 0, 1), (1, 11, 1, 1);
    INSERT INTO opt_out VALUES (1, 10, 2), (1, 11, 2);
    INSERT INTO poll_voter VALUES (1, 2, 5);
  `);
  old.close();
  for (let pass = 0; pass < 2; pass++) { // second open: idempotent
    const m = d.open(p);
    assert.match(m.prepare("SELECT sql FROM sqlite_master WHERE name = 'item'").get().sql, /AUTOINCREMENT/i);
    assert.equal(m.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys back ON');
    assert.deepEqual(m.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(m.prepare('SELECT id, receipt_id, name, price_cents, item_code FROM item ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 10, receipt_id: 1, name: 'a', price_cents: 100, item_code: '111' },
      { id: 11, receipt_id: 1, name: 'b', price_cents: 200, item_code: null },
      { id: 12, receipt_id: 2, name: 'c', price_cents: 300, item_code: null },
    ]);
    assert.equal(m.prepare('SELECT COUNT(*) n FROM opt_out').get().n, 2, 'children survived the rebuild');
    assert.equal(m.prepare('SELECT COUNT(*) n FROM polled_item').get().n, 2);
    assert.equal(m.prepare('SELECT COUNT(*) n FROM poll_voter').get().n, 1);
    assert.ok(JSON.parse(m.prepare('SELECT locked_split FROM receipt WHERE id = 2').get().locked_split).split.totalCents === 300, 'locked split untouched');
    assert.ok(m.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get('idx_item_receipt'));
    m.close();
  }
  const m = d.open(p);
  // The cascades still work through the renamed table.
  m.prepare('DELETE FROM item WHERE id = 11').run();
  assert.deepEqual(m.prepare('SELECT item_id FROM opt_out').all().map((r) => r.item_id), [10]);
  assert.deepEqual(m.prepare('SELECT item_id FROM polled_item').all().map((r) => r.item_id), [10]);
  // The original bug: delete the highest id, add a line -> a fresh id, never 12 again.
  m.prepare('DELETE FROM item WHERE id = 12').run();
  const ins = m.prepare("INSERT INTO item (receipt_id, name, price_cents) VALUES (2, 'new', 1)").run();
  assert.ok(Number(ins.lastInsertRowid) > 12, 'ids are not reused: ' + ins.lastInsertRowid);
  m.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true, maxRetries: 5, retryDelay: 100 });
});
