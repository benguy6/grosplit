'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSplit, evenSplitCents, TAX_PRO, TAX_EVEN } = require('./split.js');

const MEMBERS = ['ben', 'aisha', 'mira', 'kai', 'theo', 'sam'].map((id) => ({ id }));

// The 12 lines from the prototype receipt, in cents.
const ITEMS = [858, 599, 650, 219, 449, 2990, 999, 1197, 1299, 899, 649, 1850].map(
  (priceCents, i) => ({ id: i + 1, priceCents }),
);

const sumShares = (r) => Object.values(r.shares).reduce((s, x) => s + x.cents, 0);

function assertSound(result, label) {
  // INVARIANT 1 — shares always sum to the total, exactly.
  assert.equal(sumShares(result), result.totalCents, `${label}: shares must sum to total`);
  for (const [id, s] of Object.entries(result.shares)) {
    assert.ok(Number.isInteger(s.cents), `${label}: ${id} share must be whole cents, got ${s.cents}`);
    assert.ok(Number.isFinite(s.cents), `${label}: ${id} share must be finite`);
  }
}

// Deterministic PRNG so any failure reproduces from its seed.
function rng(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('invariant 1: shares sum to total — every grocer, both tax modes, random opt-outs', () => {
  const next = rng(20260830);
  let cases = 0;

  for (const grocer of MEMBERS) {
    for (const taxMode of [TAX_PRO, TAX_EVEN]) {
      for (const taxCents of [0, 1139, 7]) {
        for (let trial = 0; trial < 60; trial++) {
          // A random subset of items goes into the poll, with random opt-outs.
          const polledItemIds = ITEMS.filter(() => next() < 0.4).map((i) => i.id);
          const optOuts = [];
          for (const itemId of polledItemIds) {
            for (const m of MEMBERS) if (next() < 0.35) optOuts.push({ itemId, memberId: m.id });
          }

          const r = computeSplit({
            members: MEMBERS, items: ITEMS, optOuts, polledItemIds,
            grocerId: grocer.id, taxCents, taxMode,
          });
          assertSound(r, `grocer=${grocer.id} mode=${taxMode} tax=${taxCents} trial=${trial}`);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 2160);
});

test('invariant 1 holds under EXHAUSTIVE opt-outs (3 members × 2 items = 64 combinations)', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const items = [{ id: 1, priceCents: 1000 }, { id: 2, priceCents: 333 }];
  const polledItemIds = [1, 2];

  for (let mask = 0; mask < 64; mask++) {
    const optOuts = [];
    let bit = 0;
    for (const item of items) {
      for (const m of members) {
        if (mask & (1 << bit)) optOuts.push({ itemId: item.id, memberId: m.id });
        bit++;
      }
    }
    for (const grocer of members) {
      const r = computeSplit({
        members, items, optOuts, polledItemIds,
        grocerId: grocer.id, taxCents: 97, taxMode: TAX_PRO,
      });
      assertSound(r, `mask=${mask} grocer=${grocer.id}`);
    }
  }
});

test('invariant 2: an item can never have zero participants', () => {
  // Every single member opts out of the only item.
  const r = computeSplit({
    members: MEMBERS,
    items: [{ id: 1, priceCents: 600 }],
    optOuts: MEMBERS.map((m) => ({ itemId: 1, memberId: m.id })),
    polledItemIds: [1],
    grocerId: 'ben',
    taxCents: 0,
  });
  assertSound(r, 'everyone out');
  assert.equal(r.totalCents, 600);
  // Nobody gets it free: the item is still fully paid for.
  assert.equal(sumShares(r), 600);
});

test('the grocer can opt out; the rest cover it, and the shares still sum to the total', () => {
  const run = (optOuts) => computeSplit({
    members: MEMBERS, items: [{ id: 1, priceCents: 600 }],
    optOuts, polledItemIds: [1], grocerId: 'ben',
  });
  const withNone = run([]);
  const out = run([{ itemId: 1, memberId: 'ben' }]);
  assert.equal(out.totalCents, 600, 'the grocer still pays the whole receipt');
  assert.equal(sumShares(out), 600);
  assert.ok(out.shares.ben.cents < withNone.shares.ben.cents, 'their own share is smaller');
  assert.equal(out.shares.ben.itemCount, 0);
  for (const m of MEMBERS.filter((m) => m.id !== 'ben')) {
    assert.ok(out.shares[m.id].cents > withNone.shares[m.id].cents, m.id + ' covers a bit more');
  }
  assertSound(out, 'grocer out');
});

test('opt-outs count on any item, polled or not (hand edits)', () => {
  const r = computeSplit({
    members: MEMBERS, items: [{ id: 1, priceCents: 600 }],
    optOuts: [{ itemId: 1, memberId: 'kai' }], grocerId: 'ben',
  });
  assert.equal(r.shares.kai.cents, 0, 'kai is out of the only item');
  assert.equal(sumShares(r), 600);
  assertSound(r, 'unpolled opt-out');
});

test('non-voters stay IN — only recorded opt-outs reduce a share', () => {
  // Aisha is the only one who voted, and she voted out.
  const r = computeSplit({
    members: MEMBERS, items: [{ id: 1, priceCents: 500 }],
    optOuts: [{ itemId: 1, memberId: 'aisha' }], polledItemIds: [1], grocerId: 'ben',
  });
  assert.equal(r.shares.aisha.cents, 0);
  assert.equal(r.shares.kai.cents, 100, 'silent housemates are still in');
  assertSound(r, 'non-voters in');
});

test('coupons and deposits: negative line items reduce everyone', () => {
  const r = computeSplit({
    members: MEMBERS,
    items: [{ id: 1, priceCents: 1200 }, { id: 2, priceCents: -600 }], // $6 coupon
    grocerId: 'ben', taxCents: 0,
  });
  assert.equal(r.subtotalCents, 600);
  assert.equal(r.shares.kai.cents, 100);
  assertSound(r, 'coupon');
});

test('an all-coupon receipt (zero subtotal) splits tax evenly instead of dividing by zero', () => {
  const r = computeSplit({
    members: MEMBERS,
    items: [{ id: 1, priceCents: 500 }, { id: 2, priceCents: -500 }],
    grocerId: 'ben', taxCents: 60, taxMode: TAX_PRO,
  });
  assertSound(r, 'zero subtotal');
  assert.equal(r.totalCents, 60);
});

test('rounding remainder lands on the grocer, not on a housemate', () => {
  // $1.00 across 6 doesn't divide: 16.66… each.
  const r = computeSplit({
    members: MEMBERS, items: [{ id: 1, priceCents: 100 }], grocerId: 'mira',
  });
  assert.equal(r.shares.ben.cents, 17);
  assert.equal(r.shares.mira.cents, 100 - 17 * 5, 'grocer keeps the odd cents');
  assertSound(r, 'remainder');
});

test('receipts the current user did not pay for still balance', () => {
  for (const grocerId of ['mira', 'aisha', 'kai', 'theo']) {
    const r = computeSplit({
      members: MEMBERS, items: ITEMS, grocerId, taxCents: 1139, taxMode: TAX_PRO,
    });
    assertSound(r, `grocer=${grocerId}`);
  }
});

test('a single-member household is not a division by zero', () => {
  const r = computeSplit({
    members: [{ id: 'solo' }], items: ITEMS, grocerId: 'solo', taxCents: 1139,
  });
  assertSound(r, 'solo');
  assert.equal(r.shares.solo.cents, r.totalCents);
});

test('rejects a grocer who is not in the household', () => {
  assert.throws(
    () => computeSplit({ members: MEMBERS, items: ITEMS, grocerId: 'nobody' }),
    /not a member/,
  );
});

test('rejects an empty household', () => {
  assert.throws(() => computeSplit({ members: [], items: ITEMS, grocerId: 'ben' }), /no members/);
});

test('evenSplitCents matches the prototype display value', () => {
  assert.equal(evenSplitCents(13797, 6), 2300); // $137.97 -> $23.00 each
});
