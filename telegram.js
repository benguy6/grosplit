'use strict';

// Telegram Bot API + Mini App initData verification.
// Outbound calls use global fetch (Node 18+). No SDK.

const crypto = require('node:crypto');

// sendPoll accepts 2-10 options. The composer must cap selection at this or the
// call fails outright — see the SELECT ALL button over a 12-item receipt.
// ponytail: verify against the current Bot API before launch; Telegram has
// raised this before, and raising the constant is the only change needed.
const MAX_POLL_OPTIONS = 10;

// Telegram truncates poll options past 100 chars.
const MAX_OPTION_CHARS = 100;

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(token, method, body) {
  const res = await fetch(API(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({ ok: false, description: 'non-JSON response' }));
  if (!json.ok) {
    throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
  }
  return json.result;
}

/**
 * Verify Mini App initData.
 *
 * TRUST BOUNDARY — this is the only thing standing between a stranger and the
 * household's receipts. Never relax it, never fall back to trusting the client's
 * claimed user id.
 *
 * Per the Bot API: secret = HMAC_SHA256(key: "WebAppData", data: bot_token),
 * then compare HMAC_SHA256(key: secret, data: sorted "k=v" lines) to `hash`.
 *
 * @returns the parsed `user` object, or throws.
 */
function verifyInitData(initData, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new Error('initData missing');
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('initData has no hash');
  params.delete('hash');

  // signature is present on newer clients and is NOT part of the hash payload
  params.delete('signature');

  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('initData signature is invalid');
  }

  // Reject replays of an old capture.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) throw new Error('initData has no auth_date');
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > maxAgeSeconds) throw new Error(`initData is stale (${age}s old)`);

  const rawUser = params.get('user');
  if (!rawUser) throw new Error('initData has no user');
  return JSON.parse(rawUser);
}

// Constant-time check of the webhook's shared secret header.
function verifyWebhookSecret(headerValue, expected) {
  if (!expected) return true; // no secret configured
  const a = Buffer.from(String(headerValue ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Bot API wrappers ─────────────────────────────────────────────────────────

const sendMessage = (token, chatId, text, extra = {}) =>
  call(token, 'sendMessage', { chat_id: chatId, text, ...extra });

const sendPoll = (token, chatId, question, options) =>
  call(token, 'sendPoll', {
    chat_id: chatId,
    question,
    options,
    is_anonymous: false, // REQUIRED: anonymous polls never emit poll_answer
    allows_multiple_answers: true,
  });

const stopPoll = (token, chatId, messageId) =>
  call(token, 'stopPoll', { chat_id: chatId, message_id: messageId });

const getChatMember = (token, chatId, userId) =>
  call(token, 'getChatMember', { chat_id: chatId, user_id: userId });

const getMe = (token) => call(token, 'getMe');

const pinChatMessage = (token, chatId, messageId) =>
  call(token, 'pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });

// Being in the group IS the household invite. Left/kicked members don't count.
async function isInChat(token, chatId, userId) {
  try {
    const m = await getChatMember(token, chatId, userId);
    return ['creator', 'administrator', 'member', 'restricted'].includes(m.status);
  } catch {
    return false;
  }
}

// poll_answer is NOT in the default allowed_updates. Omit it here and votes
// silently never arrive — the single easiest way to lose a day to this.
const setWebhook = (token, url, secretToken) =>
  call(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'poll_answer', 'my_chat_member'],
  });

const getWebhookInfo = (token) => call(token, 'getWebhookInfo', {});
const deleteWebhook = (token) => call(token, 'deleteWebhook', {});
const getUpdates = (token, offset, allowed) =>
  call(token, 'getUpdates', { offset, timeout: 25, allowed_updates: allowed });

module.exports = {
  MAX_POLL_OPTIONS, MAX_OPTION_CHARS,
  call, verifyInitData, verifyWebhookSecret,
  sendMessage, sendPoll, stopPoll, getChatMember, isInChat, getMe, pinChatMessage,
  setWebhook, getWebhookInfo, deleteWebhook, getUpdates,
};
