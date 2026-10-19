'use strict';

// Opt-in LIVE check of the item-number lookup (spends a few cents; not run by `npm test`).
//   node --env-file=.env scripts/lookup-check.js "Costco Wholesale" 30650 "KS U/S QTRS"
// Prints the label, where it came from, and the seconds taken. Never prints the key.

const { fetchLabel } = require('../lookup.js');

const [store, code, printed] = process.argv.slice(2);
if (!store || !code || !printed) {
  console.error('usage: node --env-file=.env scripts/lookup-check.js "<store>" <code> "<printed text>"');
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set (run with --env-file=.env)');
  process.exit(2);
}

const t0 = Date.now();
fetchLabel({ store, code, printed })
  .then((r) => {
    console.log(JSON.stringify({ label: r.label, source: r.source, seconds: +((Date.now() - t0) / 1000).toFixed(1) }));
  })
  .catch((e) => {
    console.error('lookup failed:', e.message, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    process.exit(1);
  });
