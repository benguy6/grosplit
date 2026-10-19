'use strict';

// Receipt OCR + parse: ONE OpenAI vision call with a strict JSON schema.
// Returns transcribed lines, tax, the printed total, and a per-item confidence
// that drives aiFlagged / aiGuess. No second pass.

// ponytail: model is env-configurable because the best vision model changes
// faster than this file will. Bump OPENAI_MODEL, don't edit code.
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// Below this, an item gets the amber "AI UNSURE" treatment in Line review.
const CONFIDENCE_THRESHOLD = Number(process.env.OCR_CONFIDENCE_THRESHOLD || 0.8);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['store', 'items', 'tax', 'printed_total'],
  properties: {
    store: { type: ['string', 'null'], description: 'Shop name as printed at the top' },
    tax: { type: ['number', 'null'], description: 'Tax/GST/VAT total as printed, in currency units' },
    printed_total: { type: ['number', 'null'], description: 'The grand total as printed' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'price', 'quantity', 'confidence', 'suggested_name', 'item_number'],
        properties: {
          name: { type: 'string', description: 'Exactly as printed, abbreviations intact' },
          price: {
            type: 'number',
            description: 'LINE TOTAL in currency units. Negative for coupons, discounts, deposits.',
          },
          quantity: { type: ['number', 'null'], description: 'Units or weight if printed, else null' },
          confidence: { type: 'number', description: '0-1, how sure you are of name AND price' },
          suggested_name: {
            type: ['string', 'null'],
            description: 'Short readable label "<brand> <product>, <size/pack>" (max 40 chars) for any abbreviated or shorthand printed name, else null',
          },
          item_number: {
            type: ['string', 'null'],
            description: "The store's product/item number printed on this line, digits exactly as printed, else null",
          },
        },
      },
    },
  },
};

const PROMPT = `You are transcribing a grocery receipt. Be literal and complete.

Rules:
- Transcribe EVERY line that carries a price, in printed order.
- "price" is the LINE TOTAL as printed, not a unit price.
- Coupons, discounts, deposits and refunds are items with a NEGATIVE price.
- Do NOT include subtotal, tax, or total lines as items — those go in their own fields.
- "name" is exactly as printed, abbreviations and all.
- "item_number": many stores (Costco, Sam's Club, ...) print a product number beside each
  line, e.g. "1234567 KS U/S QTRS". Put those digits, exactly as printed, in "item_number"
  and keep them OUT of "name". If a line has no such number, null.
- "suggested_name": ALWAYS give one when the printed name is an abbreviation or store
  shorthand. Make it a short label "<brand> <product>, <size/pack>" of at most 40
  characters, using what you know of the store's shorthand. Examples: Costco "KS" = Kirkland
  Signature, "U/S" = unsalted, "QTRS" = quarters, "RL" = rolls, "ORG" = organic, "CHKN" =
  chicken. "KS U/S QTRS" -> "Kirkland unsalted butter, 4 sticks"; "SPCY CHKN SNDWCH" ->
  "Spicy chicken sandwich". If the name is already plain English, null.
- "confidence" reflects how clearly you can read BOTH the name and the price.
  Use below 0.8 when the text is blurred, cut off, or ambiguous.
- Never invent a line you cannot see. Omission is better than invention.`;

function toCents(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * @param imageBuffer Buffer of the receipt photo
 * @param mimeType    e.g. 'image/jpeg'
 * @returns { store, taxCents, printedTotalCents, items: [{name, priceCents, quantity, aiFlagged, aiGuess}] }
 */
async function parseReceipt(imageBuffer, mimeType = 'image/jpeg', { apiKey = process.env.OPENAI_API_KEY } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    signal: AbortSignal.timeout(60000),
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this receipt.' },
            { type: 'image_url', image_url: { url: dataUri, detail: 'high' } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'receipt', strict: true, schema: SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no content');

  return normalise(JSON.parse(content));
}

// Split out so it can be tested without a network call.
function normalise(parsed) {
  const items = (parsed.items || [])
    .map((it) => {
      const priceCents = toCents(it.price);
      if (priceCents === null) return null; // a line we cannot price is not a line
      const unsure = (it.confidence ?? 1) < CONFIDENCE_THRESHOLD;
      const guess = it.suggested_name && it.suggested_name !== it.name ? String(it.suggested_name).trim().slice(0, 40) : null;
      const code = it.item_number ? String(it.item_number).replace(/\s+/g, '').slice(0, 32) : null;
      return {
        name: it.name,
        priceCents,
        quantity: it.quantity ?? null,
        // Flagged when the read is shaky OR the printed name needs expanding —
        // both are cases where a human should look before the split is locked.
        aiFlagged: unsure || guess !== null,
        aiGuess: guess,
        itemCode: code || null,
      };
    })
    .filter(Boolean);

  return {
    store: parsed.store || null,
    taxCents: toCents(parsed.tax) ?? 0,
    printedTotalCents: toCents(parsed.printed_total),
    items,
  };
}

module.exports = { parseReceipt, normalise, CONFIDENCE_THRESHOLD, MODEL };
