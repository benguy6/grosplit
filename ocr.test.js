'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalise } = require('./ocr.js');

const raw = (over = {}) => ({
  store: "Trader Joe's",
  tax: 11.39,
  printed_total: 137.97,
  items: [{ name: 'Eggs, dozen', price: 5.99, quantity: null, confidence: 0.99, suggested_name: null }],
  ...over,
});

test('converts currency units to integer cents without float drift', () => {
  const r = normalise(raw({ items: [
    { name: 'A', price: 8.58, quantity: 2, confidence: 1, suggested_name: null },
    { name: 'B', price: 29.9, quantity: null, confidence: 1, suggested_name: null },
    { name: 'C', price: 0.1, quantity: null, confidence: 1, suggested_name: null },
  ] }));
  assert.deepEqual(r.items.map((i) => i.priceCents), [858, 2990, 10]);
  assert.equal(r.taxCents, 1139);
  assert.equal(r.printedTotalCents, 13797);
});

test('an abbreviated name is flagged and carries the expansion as aiGuess', () => {
  const r = normalise(raw({ items: [
    { name: 'SPCY CHKN SNDWCH', price: 6.5, quantity: null, confidence: 0.97, suggested_name: 'Spicy chicken sandwich' },
  ] }));
  assert.equal(r.items[0].aiFlagged, true, 'confident but abbreviated still needs a human');
  assert.equal(r.items[0].aiGuess, 'Spicy chicken sandwich');
});

test('low confidence flags an item even with no better name to offer', () => {
  const r = normalise(raw({ items: [
    { name: 'Bananas', price: 2.19, quantity: null, confidence: 0.4, suggested_name: null },
  ] }));
  assert.equal(r.items[0].aiFlagged, true);
  assert.equal(r.items[0].aiGuess, null);
});

test('a clean confident line is not flagged', () => {
  const r = normalise(raw());
  assert.equal(r.items[0].aiFlagged, false);
  assert.equal(r.items[0].aiGuess, null);
});

test('a suggested_name identical to the printed name is not a guess', () => {
  const r = normalise(raw({ items: [
    { name: 'Dish soap', price: 4.49, quantity: null, confidence: 1, suggested_name: 'Dish soap' },
  ] }));
  assert.equal(r.items[0].aiFlagged, false);
  assert.equal(r.items[0].aiGuess, null);
});

test('coupons survive as negative cents', () => {
  const r = normalise(raw({ items: [
    { name: 'MFR COUPON', price: -3.0, quantity: null, confidence: 0.95, suggested_name: null },
  ] }));
  assert.equal(r.items[0].priceCents, -300);
});

test('an unpriceable line is dropped rather than stored as zero', () => {
  const r = normalise(raw({ items: [
    { name: 'Eggs', price: 5.99, quantity: null, confidence: 1, suggested_name: null },
    { name: 'illegible', price: null, quantity: null, confidence: 0.2, suggested_name: null },
  ] }));
  assert.equal(r.items.length, 1);
});

test('a receipt with no tax line yields zero, not null', () => {
  const r = normalise(raw({ tax: null }));
  assert.equal(r.taxCents, 0);
});

test('missing printed_total is null so reconciliation simply skips', () => {
  const r = normalise(raw({ printed_total: null }));
  assert.equal(r.printedTotalCents, null);
});
