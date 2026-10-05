'use strict';

// The split algorithm. Pure — no I/O, no dates, no globals.
//
// All money is INTEGER CENTS. `priceCents` on an item is the LINE TOTAL as
// printed on the receipt; `quantity` is display metadata only ("×2"), never a
// multiplier here, because receipts print line totals and so does our OCR.
// Coupons and deposits are ordinary items with a negative priceCents.

const TAX_PRO = 'pro';   // tax follows what each person actually owes
const TAX_EVEN = 'even'; // flat tax/n each

/**
 * @param members       [{ id }]                       — the whole household
 * @param items         [{ id, priceCents }]           — line totals, may be negative
 * @param optOuts       [{ itemId, memberId }]         — from the Telegram poll
 * @param polledItemIds [itemId]                       — only these can carry opt-outs
 * @param grocerId      member id who paid for THIS receipt
 * @param taxCents      read off the receipt; 0 when tax isn't split
 * @param taxMode       'pro' | 'even'
 */
function computeSplit({
  members,
  items,
  optOuts = [],
  polledItemIds = [],
  grocerId,
  taxCents = 0,
  taxMode = TAX_PRO,
}) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('computeSplit: household has no members');
  }
  if (!members.some((m) => m.id === grocerId)) {
    throw new Error(`computeSplit: grocer "${grocerId}" is not a member of this household`);
  }

  const n = members.length;
  const polled = new Set(polledItemIds);
  const amt = new Map(members.map((m) => [m.id, 0]));       // fractional cents while accumulating
  const itemCount = new Map(members.map((m) => [m.id, 0]));

  let subtotalCents = 0;

  for (const item of items) {
    subtotalCents += item.priceCents;

    // Opt-outs only count on items that actually went into the poll, and the
    // grocer can never opt out of a receipt they paid for.
    const out = polled.has(item.id)
      ? new Set(
          optOuts
            .filter((o) => o.itemId === item.id && o.memberId !== grocerId)
            .map((o) => o.memberId),
        )
      : new Set();

    let participants = members.filter((m) => !out.has(m.id));

    // Invariant: an item can never have zero participants. Excluding the grocer
    // from `out` already guarantees this; the floor is here so the guarantee is
    // structural rather than a consequence of the line above staying correct.
    if (participants.length === 0) participants = members;

    const each = item.priceCents / participants.length;
    for (const m of participants) {
      amt.set(m.id, amt.get(m.id) + each);
      itemCount.set(m.id, itemCount.get(m.id) + 1);
    }
  }

  const totalCents = subtotalCents + taxCents;

  const taxShare = new Map(members.map((m) => [m.id, 0]));
  if (taxCents !== 0) {
    for (const m of members) {
      // Pro-rata needs a non-zero subtotal to divide by; an all-coupon receipt
      // falls back to an even split rather than producing NaN.
      const t =
        taxMode === TAX_EVEN || subtotalCents === 0
          ? taxCents / n
          : (amt.get(m.id) / subtotalCents) * taxCents;
      taxShare.set(m.id, t);
      amt.set(m.id, amt.get(m.id) + t);
    }
  }

  // Round every non-grocer to whole cents; the grocer absorbs the remainder so
  // the shares sum to the total EXACTLY, by construction rather than by luck.
  const cents = new Map();
  let owedCents = 0;
  for (const m of members) {
    if (m.id === grocerId) continue;
    const c = Math.round(amt.get(m.id));
    cents.set(m.id, c);
    owedCents += c;
  }
  cents.set(grocerId, totalCents - owedCents);

  return {
    subtotalCents,
    taxCents,
    totalCents,
    owedCents, // what the grocer is owed back by everyone else
    shares: Object.fromEntries(
      members.map((m) => [
        m.id,
        {
          cents: cents.get(m.id),
          // ponytail: per-member tax is rounded for display only, so these need
          // not sum to taxCents. The design only ever shows it as a sub-line
          // ("+$2.06 TAX"), never totalled. Accumulate unrounded if that changes.
          taxCents: Math.round(taxShare.get(m.id)),
          itemCount: itemCount.get(m.id),
        },
      ]),
    ),
  };
}

// The "everyone in on everything" figure shown before a poll runs.
function evenSplitCents(totalCents, n) {
  return Math.round(totalCents / n);
}

module.exports = { computeSplit, evenSplitCents, TAX_PRO, TAX_EVEN };
