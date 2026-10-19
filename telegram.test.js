'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyInitData, verifyWebhookSecret } = require('./telegram.js');

const TOKEN = '123456:AAEtest-token-not-real';

// Build a genuinely signed initData string the way Telegram would.
function signInitData(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const now = () => Math.floor(Date.now() / 1000);
const validFields = (over = {}) => ({
  query_id: 'AAF_test',
  user: JSON.stringify({ id: 99001, first_name: 'Ben', username: 'benguy' }),
  auth_date: String(now()),
  ...over,
});

test('accepts a correctly signed payload and returns the user', () => {
  const user = verifyInitData(signInitData(validFields()), TOKEN);
  assert.equal(user.id, 99001);
  assert.equal(user.username, 'benguy');
});

test('rejects a tampered user field', () => {
  const good = signInitData(validFields());
  const p = new URLSearchParams(good);
  p.set('user', JSON.stringify({ id: 1, first_name: 'Attacker' })); // hash now stale
  assert.throws(() => verifyInitData(p.toString(), TOKEN), /invalid/);
});

test('rejects a payload signed with a different bot token', () => {
  const signedElsewhere = signInitData(validFields(), '999:OTHER-BOT-TOKEN');
  assert.throws(() => verifyInitData(signedElsewhere, TOKEN), /invalid/);
});

test('rejects a replayed capture older than the window', () => {
  const old = signInitData(validFields({ auth_date: String(now() - 60 * 60 * 48) }));
  assert.throws(() => verifyInitData(old, TOKEN), /stale/);
});

test('rejects missing hash, empty input, and absent user', () => {
  assert.throws(() => verifyInitData('user=%7B%7D&auth_date=1', TOKEN), /no hash/);
  assert.throws(() => verifyInitData('', TOKEN), /missing/);
  const noUser = signInitData({ auth_date: String(now()), query_id: 'x' });
  assert.throws(() => verifyInitData(noUser, TOKEN), /no user/);
});

test('accepts newer clients that send `signature`, which IS part of the HMAC payload', () => {
  // Telegram (Bot API 8.0+) signs `signature` into the hash like any other field;
  // only `hash` is excluded. Dropping it rejected every real phone.
  const signed = signInitData(validFields({ signature: 'ed25519_sig_from_telegram' }));
  assert.equal(verifyInitData(signed, TOKEN).id, 99001);

  // …so it can't be swapped after signing either.
  const p = new URLSearchParams(signed);
  p.set('signature', 'swapped');
  assert.throws(() => verifyInitData(p.toString(), TOKEN), /invalid/);
});

test('webhook secret comparison rejects wrong and accepts right', () => {
  assert.equal(verifyWebhookSecret('s3cret', 's3cret'), true);
  assert.equal(verifyWebhookSecret('wrong', 's3cret'), false);
  assert.equal(verifyWebhookSecret(undefined, 's3cret'), false);
  assert.equal(verifyWebhookSecret('anything', ''), true); // none configured
});
