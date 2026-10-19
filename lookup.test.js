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
beforeEach(() => { db.exec('DELETE FROM product_lookup'); console.log = () => {}; });
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
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_lookup').get().n, 0);
  assert.equal(lookup.pending(id), 0);
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
