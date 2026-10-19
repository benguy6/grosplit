'use strict';

// Item-number -> readable label (F2). Receipts like Costco's print a product number beside
// each line. After a scan we fill the "Use AI guess" suggestion from a per-store cache, and
// look up the rest on the web in the background. Results only ever touch ai_guess/ai_flagged,
// never the name or price.
//
// Privacy: only the store name, the item number and the printed item text go to OpenAI.

const d = require('./db.js');

const MAX_LOOKUPS = 15;        // per receipt
const CONCURRENCY = 3;
const TIMEOUT_MS = 20000;
const UNKNOWN_RETRY_SECONDS = 30 * 24 * 3600;
const FAILED_RETRY_SECONDS = 3600; // a lookup that errored: don't hammer it on every rescan
// Calls (decode + web = 2 per lookup) the whole deployment may spend in any rolling 24h.
const dailyCap = () => Number(process.env.LOOKUP_DAILY_CAP || 100);
// ponytail: env-configurable because the best cheap web-capable model changes often.
const model = () => process.env.OPENAI_LOOKUP_MODEL || 'gpt-4o-mini';

// "Costco Wholesale" -> "costco", "Trader Joe's" -> "trader joes"
const storeKey = (store) =>
  String(store || '').toLowerCase().replace(/['’]/g, '').replace(/\bwholesale\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

const MAX_LABEL = 60; // the UI ellipsises if it must

// Phase 1: read the PRINTED text only (no web, no item number): cheap, and it is the ground
// truth we hold the web answer to.
const DECODE_FORMAT = {
  type: 'json_schema', name: 'decoded', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['label', 'confident', 'product_noun'],
    properties: {
      label: { type: ['string', 'null'] },
      confident: { type: 'boolean' },
      product_noun: { type: ['string', 'null'] }, // the core product, one lowercase word
    },
  },
};
// Phase 2: web search by item number, for detail (brand, size, pack).
const WEB_FORMAT = {
  type: 'json_schema', name: 'product', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['label', 'confident'],
    properties: { label: { type: ['string', 'null'] }, confident: { type: 'boolean' } },
  },
};

const decodeQuestion = (store, printed) =>
  `A ${store} (US) receipt prints a line as "${printed}". Using only your knowledge of how this store abbreviates ` +
  '(e.g. Costco: KS = Kirkland Signature, U/S = unsalted, QTRS = quarters, RL = rolls, PPR TWL = paper towels, ORG = organic), ' +
  `say what product it is. label: short, brand + product + size if printed, at most ${MAX_LABEL} characters. ` +
  'product_noun: the core product as ONE lowercase word (butter, towels, bananas). ' +
  'If you cannot tell, set confident to false and label and product_noun to null. Do not guess from anything but the text.';

const webQuestion = (store, code, printed) =>
  `What product is ${store} (US) item number ${code}, printed on the receipt as "${printed}"? ` +
  `Give ONE short label (brand, product, size; at most ${MAX_LABEL} characters), like "Kirkland unsalted butter, 4 sticks". ` +
  'Set confident to false and label to null if you cannot tell.';

// A label is a short noun phrase. Anything that reads like a sentence (or the printed text
// again) is "unknown" — we never truncate a longer answer into a label.
const SENTENCE_START = /^(based on|i\b|i'|the item|the product|it\b|this\b|there\b|according|sorry|unknown|unable|unfortunately|no\b|not\b)/i;
function validLabel(label, printed) {
  if (typeof label !== 'string') return null;
  const t = label.replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_LABEL || /[.!?:]$/.test(t) || SENTENCE_START.test(t)) return null;
  // The label ends up in the UI: no markup, no links, no long digit runs (phone/codes).
  if (/[<>{}]/.test(t) || /:\/\/|www\.|\.(com|net|org|io|co|app)\b/i.test(t) || /\d{7,}/.test(t)) return null;
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(t) === norm(printed)) return null;
  return t;
}

// "towels" also matches "towel"; "bananas" matches "banana"; "berries" matches "berry".
function containsNoun(label, noun) {
  const n = String(noun || '').toLowerCase().trim();
  if (!n) return false;
  const forms = new Set([n, n + 's', n + 'es', n.replace(/ies$/, 'y'), n.replace(/y$/, 'ies'), n.replace(/s$/, ''), n.replace(/es$/, '')]);
  const l = label.toLowerCase();
  return [...forms].some((f) => f.length > 2 && l.includes(f));
}

// One Responses API call. Returns { status, ok, json } and only throws on network/timeout.
async function post(body, apiKey) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model(), ...body }),
  });
  return { status: res.status, ok: res.ok, json: res.ok ? await res.json() : null };
}
const textOf = (json) => json.output_text ?? (json.output || [])
  .flatMap((o) => (o.content || []).map((c) => c.text || '')).join(' ');
const parse = (json) => { try { return JSON.parse(textOf(json)); } catch { return null; } }; // prose -> null

/**
 * Item number -> label, with CODE enforcing that the answer agrees with the printed text.
 *   1. DECODE the printed text alone (no web): label + the core product noun.
 *   2. WEB search by item number, for detail.
 *   3. Pick: the web label if it contains the decoded product noun; else the decoded label if
 *      the decode was confident; else unknown. (The web can find any product for a number;
 *      it must never override what the receipt itself says.)
 * Returns { label|null, source: 'web'|'decoded'|'unknown' }. Throws on timeout/network/HTTP
 * failure with nothing usable (the caller then sets and caches nothing).
 */
async function fetchLabel({ store, code, printed }, { apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey) throw new Error('no OPENAI_API_KEY');

  const dec = await post({ input: decodeQuestion(store, printed), text: { format: DECODE_FORMAT } }, apiKey);
  if (!dec.ok) throw new Error('OpenAI ' + dec.status);
  const decoded = parse(dec.json) || {};
  const decodedLabel = decoded.confident === true ? validLabel(decoded.label, printed) : null;
  const noun = typeof decoded.product_noun === 'string' ? decoded.product_noun : '';

  let webLabel = null;
  try {
    for (const tool of ['web_search', 'web_search_preview']) {
      const r = await post({ input: webQuestion(store, code, printed), tools: [{ type: tool }], text: { format: WEB_FORMAT } }, apiKey);
      if (r.ok) {
        const w = parse(r.json);
        webLabel = w && w.confident === true ? validLabel(w.label, printed) : null;
        break;
      }
      if (r.status !== 400) throw new Error('OpenAI ' + r.status);
    }
  } catch (e) {
    if (!decodedLabel) throw e; // nothing usable and the web failed: let it be retried later
  }

  if (webLabel && containsNoun(webLabel, noun)) return { label: webLabel, source: 'web' };
  if (decodedLabel) return { label: decodedLabel, source: 'decoded' };
  return { label: null, source: 'unknown' };
}

const inFlight = new Map(); // receiptId -> lookups still running
const lookingUp = new Set(); // 'storeKey|code' being looked up right now (a rescan must not pay twice)
const startedFor = new Map(); // receiptId -> lookups ever started (the 15 cap is per receipt, not per scan)
const running = new Set();  // promises, so tests (and shutdown) can wait
const pending = (receiptId) => inFlight.get(receiptId) || 0;
const whenIdle = async () => { while (running.size) await Promise.allSettled([...running]); };

/**
 * Call after a scan has stored the items. Fills cached labels immediately, then starts the
 * background lookups (not awaited). Returns counts for logging.
 */
function afterScan(db, receiptId, { fetchLabel: fetcher = fetchLabel, apiKey = process.env.OPENAI_API_KEY } = {}) {
  const r = d.receipt(db, receiptId);
  const key = storeKey(r && r.store);
  const now = Math.floor(Date.now() / 1000);
  let cached = 0;
  const todo = [];
  if (key) {
    const getCache = db.prepare('SELECT * FROM product_lookup WHERE store_key = ? AND item_code = ?');
    for (const it of d.items(db, receiptId)) {
      if (!it.item_code) continue;
      const hit = getCache.get(key, it.item_code);
      if (hit && hit.label) {
        // Only the suggestion; whether the line looks "unsure" stays what the reader decided.
        db.prepare('UPDATE item SET ai_guess = ? WHERE id = ?').run(hit.label, it.id);
        cached++;
      } else if (hit && now - hit.looked_up_at < (hit.source === 'failed' ? FAILED_RETRY_SECONDS : UNKNOWN_RETRY_SECONDS)) {
        // recently answered "unknown" (or recently failed): don't pay again
      } else if (it.ai_flagged && !lookingUp.has(key + '|' + it.item_code)) {
        todo.push(it);
      }
    }
  }
  // Per receipt (across rescans), then the whole deployment's daily budget.
  const room = Math.max(0, MAX_LOOKUPS - (startedFor.get(receiptId) || 0));
  const spent = key
    ? db.prepare('SELECT COUNT(*) AS n FROM product_lookup WHERE looked_up_at >= ?').get(now - 86400).n * 2 + lookingUp.size * 2
    : 0;
  const budget = Math.max(0, Math.floor((dailyCap() - spent) / 2));
  const queue = [];
  const seen = new Set();
  for (const it of todo) { // the same code twice on one receipt is one lookup
    if (queue.length >= Math.min(room, budget)) break;
    if (!seen.has(it.item_code)) { seen.add(it.item_code); queue.push(it); }
  }
  const sent = apiKey ? queue.length : 0;
  const skipped = apiKey ? todo.length - sent : 0;
  console.log(`lookups: ${sent} sent, ${cached} cached, ${skipped} skipped`); // counts only — never item text
  if (!sent) return { sent, cached };

  startedFor.set(receiptId, (startedFor.get(receiptId) || 0) + sent);
  inFlight.set(receiptId, pending(receiptId) + sent); // add: a rescan must not shorten the client's polling
  for (const it of queue) lookingUp.add(key + '|' + it.item_code);
  const store = r.store;
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const { label, source } = await fetcher({ store, code: it.item_code, printed: it.name }, { apiKey });
        db.prepare(
          'INSERT OR REPLACE INTO product_lookup (store_key, item_code, label, source, looked_up_at) VALUES (?, ?, ?, ?, ?)',
        ).run(key, it.item_code, label, label ? source : 'unknown', Math.floor(Date.now() / 1000));
        // Only if the line is still there, the receipt is still in review, and the user hasn't
        // touched its name or guess meanwhile.
        if (label) {
          db.prepare(
            `UPDATE item SET ai_guess = ? WHERE id = ? AND receipt_id = ? AND name = ? AND ai_guess IS ?
               AND EXISTS (SELECT 1 FROM receipt r WHERE r.id = item.receipt_id AND r.status = 'review')`,
          ).run(label, it.id, receiptId, it.name, it.ai_guess);
        }
      } catch {
        // Timeout/network: set no guess, and remember the failure briefly so a rescan doesn't retry at once.
        try {
          db.prepare(
            "INSERT OR REPLACE INTO product_lookup (store_key, item_code, label, source, looked_up_at) VALUES (?, ?, NULL, 'failed', ?)",
          ).run(key, it.item_code, Math.floor(Date.now() / 1000));
        } catch { /* closed db */ }
      } finally {
        lookingUp.delete(key + '|' + it.item_code);
        inFlight.set(receiptId, Math.max(0, pending(receiptId) - 1));
      }
    }
  };
  const p = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    .finally(() => { running.delete(p); if (!pending(receiptId)) inFlight.delete(receiptId); });
  running.add(p);
  return { sent, cached };
}

module.exports = { afterScan, fetchLabel, validLabel, containsNoun, storeKey, pending, whenIdle, MAX_LOOKUPS, CONCURRENCY };
