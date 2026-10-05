'use strict';

// Demo data for local development — only ever runs when there is no bot token.
// Mirrors the prototype exactly so the screens can be compared side by side:
// subtotal $126.58, tax $11.39, total $137.97.

const d = require('./db.js');

const MEMBERS = [
  { name: 'Ben', handle: '@BENGUY' },
  { name: 'Aisha', handle: '@AISHAK' },
  { name: 'Mira', handle: '@MIRAW' },
  { name: 'Kai', handle: '@KAIT' },
  { name: 'Théo', handle: '@THEOL' },
  { name: 'Sam', handle: '@SAMP' },
];

const ACTIVE_ITEMS = [
  { name: 'Oat milk 1L', priceCents: 858, quantity: 2 },
  { name: 'Eggs, dozen', priceCents: 599 },
  { name: 'SPCY CHKN SNDWCH', priceCents: 650, aiFlagged: true, aiGuess: 'Spicy chicken sandwich' },
  { name: 'Bananas, bunch', priceCents: 219 },
  { name: 'Dish soap', priceCents: 449 },
  { name: 'Protein powder', priceCents: 2990 },
  { name: 'Cold brew concentrate', priceCents: 999 },
  { name: 'Frozen dumplings', priceCents: 1197, quantity: 3 },
  { name: 'Olive oil 750ml', priceCents: 1299 },
  { name: 'PPR TWL 6RL', priceCents: 899, aiFlagged: true, aiGuess: 'Paper towels, 6 roll' },
  { name: 'Greek yogurt tub', priceCents: 649 },
  { name: 'Coffee beans 1kg', priceCents: 1850 },
];

const PANTRY = [
  'Milk 2L', 'Sourdough loaf', 'Chicken thigh', 'Rice 5kg', 'Tomatoes', 'Onions 1kg',
  'Cheddar block', 'Pasta 500g', 'Tinned tomatoes', 'Kimchi 500g', 'Sriracha', 'Trash bags',
  'Laundry pods', 'Frozen peas', 'Apples', 'Butter', 'Salmon fillet', 'Spinach', 'Garlic',
];

// Spread a total across n plausible lines; the last line absorbs the remainder so
// the displayed items always add up to the displayed total.
function linesFor(totalCents, n, offset = 0) {
  const rows = [];
  let left = totalCents;
  for (let i = 0; i < n - 1; i++) {
    const remaining = n - i;
    const avg = Math.floor(left / remaining);
    const wobble = ((i * 37 + offset * 11) % 21) - 10; // deterministic, not random
    const price = Math.max(99, avg + wobble * 10);
    rows.push({ name: PANTRY[(i + offset) % PANTRY.length], priceCents: price });
    left -= price;
  }
  rows.push({ name: PANTRY[(n - 1 + offset) % PANTRY.length], priceCents: left });
  return rows;
}

const DAY = 86400;

function ensureDemo(db) {
  if (d.firstHousehold(db)) return; // already seeded

  const house = d.createHousehold(db, { name: 'Blk 42 · #05-11' });
  const members = MEMBERS.map((m) =>
    d.addMember(db, house.id, { name: m.name, telegramHandle: m.handle, telegramUserId: null }),
  );
  const [ben, aisha, mira, kai, theo, sam] = members;

  const now = Math.floor(Date.now() / 1000);

  // The live receipt: needs review, two AI-unsure lines.
  const active = d.createReceipt(db, {
    householdId: house.id,
    store: "Trader Joe's",
    grocerId: ben.id,
    createdAt: now - 600,
  });
  d.replaceItems(db, active.id, ACTIVE_ITEMS);
  db.prepare('UPDATE receipt SET tax_cents = ?, printed_total_cents = ? WHERE id = ?')
    .run(1139, 13797, active.id);

  // Settled history, matching the prototype's History screen.
  const past = [
    { store: 'Safeway', grocer: mira, total: 6120, n: 9, days: 5 },
    { store: 'Whole Foods', grocer: aisha, total: 8840, n: 14, days: 9 },
    { store: 'Costco', grocer: kai, total: 4205, n: 6, days: 13 },
    { store: 'Target', grocer: theo, total: 10390, n: 19, days: 18 },
    { store: "Trader Joe's", grocer: sam, total: 7460, n: 11, days: 25 },
  ];

  past.forEach((p, i) => {
    const r = d.createReceipt(db, {
      householdId: house.id,
      store: p.store,
      grocerId: p.grocer.id,
      createdAt: now - p.days * DAY,
    });
    d.replaceItems(db, r.id, linesFor(p.total, p.n, i * 3));
    // Tax off on historical receipts so the printed total equals the line sum.
    db.prepare("UPDATE receipt SET status = 'confirmed', tax_enabled = 0, tax_cents = 0, printed_total_cents = ? WHERE id = ?")
      .run(p.total, r.id);
  });

  return house;
}

module.exports = { ensureDemo, ACTIVE_ITEMS, MEMBERS };
