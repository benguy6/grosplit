'use strict';

// SQLite via node:sqlite — no driver dependency. One file, seven tables.
// All money columns are integer cents. All timestamps are unix seconds.

const { DatabaseSync } = require('node:sqlite');
const { computeSplit } = require('./split.js');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS household (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  telegram_chat_id  TEXT    UNIQUE,
  poll_window_hours INTEGER NOT NULL DEFAULT 4,
  auto_flag_staples INTEGER NOT NULL DEFAULT 1,
  round_to_cent     INTEGER NOT NULL DEFAULT 1,
  currency          TEXT    NOT NULL DEFAULT '$'
);

CREATE TABLE IF NOT EXISTS member (
  id               INTEGER PRIMARY KEY,
  household_id     INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  initial          TEXT    NOT NULL,
  avatar_color     TEXT    NOT NULL,
  telegram_handle  TEXT,
  telegram_user_id TEXT    UNIQUE
);

CREATE TABLE IF NOT EXISTS receipt (
  id                  INTEGER PRIMARY KEY,
  household_id        INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  store               TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  grocer_id           INTEGER NOT NULL REFERENCES member(id),
  tax_cents           INTEGER NOT NULL DEFAULT 0,
  tax_enabled         INTEGER NOT NULL DEFAULT 1,
  tax_mode            TEXT    NOT NULL DEFAULT 'pro',
  status              TEXT    NOT NULL DEFAULT 'review',
  telegram_poll_id    TEXT,
  poll_message_id     INTEGER,
  poll_closes_at      INTEGER,
  printed_total_cents INTEGER,
  locked_split        TEXT,
  created_by          INTEGER
);

CREATE TABLE IF NOT EXISTS item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity    REAL,
  ai_flagged  INTEGER NOT NULL DEFAULT 0,
  ai_guess    TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  item_code   TEXT
);

-- One row per PAID OpenAI request (decode and web each count), for the daily cap.
CREATE TABLE IF NOT EXISTS lookup_call (at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lookup_call_at ON lookup_call(at);

-- Cached answers to "what is item number N at store S" (F2). label NULL = looked up, unknown.
CREATE TABLE IF NOT EXISTS product_lookup (
  store_key    TEXT    NOT NULL,
  item_code    TEXT    NOT NULL,
  label        TEXT,
  source       TEXT,
  looked_up_at INTEGER NOT NULL,
  PRIMARY KEY (store_key, item_code)
);

-- One receipt can have several Telegram polls (max 9 items each), numbered by part.
CREATE TABLE IF NOT EXISTS poll (
  id               INTEGER PRIMARY KEY,
  receipt_id       INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
  part             INTEGER NOT NULL,
  telegram_poll_id TEXT    UNIQUE,
  message_id       INTEGER
);

-- option_index is per poll.
CREATE TABLE IF NOT EXISTS polled_item (
  receipt_id   INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  poll_id      INTEGER REFERENCES poll(id) ON DELETE CASCADE,
  PRIMARY KEY (receipt_id, item_id)
);

CREATE TABLE IF NOT EXISTS opt_out (
  receipt_id INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  PRIMARY KEY (receipt_id, item_id, member_id)
);

-- Who has answered which poll.
CREATE TABLE IF NOT EXISTS poll_voter (
  poll_id   INTEGER NOT NULL REFERENCES poll(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  voted_at  INTEGER NOT NULL,
  PRIMARY KEY (poll_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_item_receipt   ON item(receipt_id, position);
CREATE INDEX IF NOT EXISTS idx_receipt_house  ON receipt(household_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_optout_receipt ON opt_out(receipt_id);
`;

// Assigned on join, never reshuffled. From the design tokens.
const PALETTE = ['#E8552D', '#3B7A57', '#5C574F', '#D9A400', '#8A6A4B', '#7A8B99', '#B0473F', '#4F6B8A', '#C2577A']; // last: pink (owner request)

function open(path) {
  const db = new DatabaseSync(path);
  // Wait up to 5s for another connection's lock, then fail loudly. Without
  // this a second connection blocks forever with no error, which looks like a
  // hung process rather than contention.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// In-place upgrades for databases created by an older schema (CREATE TABLE IF
// NOT EXISTS never adds columns).
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(receipt)').all().map((c) => c.name);
  if (!cols.includes('locked_split')) db.exec('ALTER TABLE receipt ADD COLUMN locked_split TEXT');
  // NULL for receipts that predate it: only their grocer can manage them.
  if (!cols.includes('created_by')) db.exec('ALTER TABLE receipt ADD COLUMN created_by INTEGER');
  const itemCols = db.prepare('PRAGMA table_info(item)').all().map((c) => c.name);
  if (!itemCols.includes('item_code')) db.exec('ALTER TABLE item ADD COLUMN item_code TEXT');
  rebuildItemAutoincrement(db);
  // Receipts confirmed before freezing existed get frozen now, from today's members.
  const old = db.prepare("SELECT id FROM receipt WHERE status = 'confirmed' AND locked_split IS NULL").all();
  for (const r of old) freezeSplit(db, r.id);
  migratePolls(db);
}

// SQLite reuses the highest item id after a delete unless the key is AUTOINCREMENT, so a stale
// edit sheet could overwrite a DIFFERENT line that got the freed id. Existing databases need a
// table rebuild (SQLite can't alter a primary key). Idempotent: skipped once it is AUTOINCREMENT.
//
// Foreign keys: item is referenced by polled_item and opt_out (ON DELETE CASCADE). Dropping a
// parent table with foreign_keys ON would cascade-delete those rows, so we follow SQLite's
// documented procedure: foreign_keys OFF (it cannot change inside a transaction, so before
// BEGIN), rebuild in one transaction, `PRAGMA foreign_key_check` before COMMIT (any violation
// rolls everything back), then foreign_keys ON again. The children refer to "item" by name, so
// renaming item_new -> item reconnects them with no change to their own tables.
function rebuildItemAutoincrement(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'item'").get();
  if (!row || /AUTOINCREMENT/i.test(row.sql)) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE item_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id  INTEGER NOT NULL REFERENCES receipt(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        price_cents INTEGER NOT NULL,
        quantity    REAL,
        ai_flagged  INTEGER NOT NULL DEFAULT 0,
        ai_guess    TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        item_code   TEXT
      )`);
      db.exec(`INSERT INTO item_new (id, receipt_id, name, price_cents, quantity, ai_flagged, ai_guess, position, item_code)
               SELECT id, receipt_id, name, price_cents, quantity, ai_flagged, ai_guess, position, item_code FROM item`);
      db.exec('DROP TABLE item');
      db.exec('ALTER TABLE item_new RENAME TO item');
      db.exec('CREATE INDEX IF NOT EXISTS idx_item_receipt ON item(receipt_id, position)');
      // Copying explicit ids already set sqlite_sequence to max(id); make sure it can only be higher.
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM item').get().m;
      db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'item'").run(max);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign_key_check failed after rebuilding item');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Single-poll-per-receipt -> several polls. Idempotent: each step checks its own state.
function migratePolls(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  db.exec('BEGIN');
  try {
    if (!has('polled_item', 'poll_id')) {
      db.exec('ALTER TABLE polled_item ADD COLUMN poll_id INTEGER REFERENCES poll(id) ON DELETE CASCADE');
    }
    // Every receipt that had a poll (or polled items) and no poll row yet gets part 1.
    const pending = db.prepare(
      `SELECT id, telegram_poll_id AS tid, poll_message_id AS mid FROM receipt r
       WHERE NOT EXISTS (SELECT 1 FROM poll p WHERE p.receipt_id = r.id)
         AND (telegram_poll_id IS NOT NULL OR EXISTS (SELECT 1 FROM polled_item pi WHERE pi.receipt_id = r.id))`,
    ).all();
    const taken = db.prepare('SELECT 1 FROM poll WHERE telegram_poll_id = ?');
    const insPoll = db.prepare('INSERT INTO poll (receipt_id, part, telegram_poll_id, message_id) VALUES (?, 1, ?, ?)');
    const attach = db.prepare('UPDATE polled_item SET poll_id = ? WHERE receipt_id = ?');
    for (const r of pending) {
      const tid = r.tid && !taken.get(r.tid) ? r.tid : null; // UNIQUE must never abort a boot
      attach.run(insPoll.run(r.id, tid, r.mid).lastInsertRowid, r.id);
    }
    if (!has('poll_voter', 'poll_id')) {
      db.exec('ALTER TABLE poll_voter RENAME TO poll_voter_old');
      db.exec(`CREATE TABLE poll_voter (
        poll_id   INTEGER NOT NULL REFERENCES poll(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
        voted_at  INTEGER NOT NULL,
        PRIMARY KEY (poll_id, member_id)
      )`);
      db.exec(`INSERT INTO poll_voter (poll_id, member_id, voted_at)
               SELECT p.id, v.member_id, v.voted_at FROM poll_voter_old v
               JOIN poll p ON p.receipt_id = v.receipt_id AND p.part = 1`);
      db.exec('DROP TABLE poll_voter_old');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The split for a receipt as it stands right now over the given members.
function computeReceiptSplit(db, r, memberList) {
  return computeSplit({
    members: memberList.map((m) => ({ id: m.id })),
    items: items(db, r.id).map((i) => ({ id: i.id, priceCents: i.price_cents })),
    optOuts: optOuts(db, r.id).map((o) => ({ itemId: o.item_id, memberId: o.member_id })),
    polledItemIds: polledItems(db, r.id).map((p) => p.item_id),
    grocerId: r.grocer_id,
    taxCents: r.tax_enabled ? r.tax_cents : 0,
    taxMode: r.tax_mode,
  });
}

// SPEC §5.3: a locked split never changes. Store the numbers AND who they covered.
function freezeSplit(db, receiptId) {
  const r = receipt(db, receiptId);
  const ms = members(db, r.household_id);
  const frozen = { memberIds: ms.map((m) => m.id), split: computeReceiptSplit(db, r, ms) };
  db.prepare('UPDATE receipt SET locked_split = ? WHERE id = ?').run(JSON.stringify(frozen), receiptId);
  return frozen;
}

// reads

const members = (db, householdId) =>
  db.prepare('SELECT * FROM member WHERE household_id = ? ORDER BY id').all(householdId);

const items = (db, receiptId) =>
  db.prepare('SELECT * FROM item WHERE receipt_id = ? ORDER BY position, id').all(receiptId);

const receipt = (db, id) => db.prepare('SELECT * FROM receipt WHERE id = ?').get(id);

const receipts = (db, householdId) =>
  db.prepare('SELECT * FROM receipt WHERE household_id = ? ORDER BY created_at DESC').all(householdId);

const polledItems = (db, receiptId) =>
  db.prepare('SELECT * FROM polled_item WHERE receipt_id = ? ORDER BY option_index').all(receiptId);

const optOuts = (db, receiptId) =>
  db.prepare('SELECT * FROM opt_out WHERE receipt_id = ?').all(receiptId);

// One row per (poll, member) answered, across all of the receipt's polls.
const voters = (db, receiptId) =>
  db.prepare(
    'SELECT v.poll_id, v.member_id, v.voted_at FROM poll_voter v JOIN poll p ON p.id = v.poll_id WHERE p.receipt_id = ?',
  ).all(receiptId);

const polls = (db, receiptId) =>
  db.prepare('SELECT * FROM poll WHERE receipt_id = ? ORDER BY part').all(receiptId);

const pollByTelegramId = (db, telegramPollId) =>
  db.prepare('SELECT * FROM poll WHERE telegram_poll_id = ?').get(String(telegramPollId));

// Forget a receipt's polls entirely: polls, their item mappings, voters and opt-outs.
function clearPolls(db, receiptId) {
  db.prepare('DELETE FROM opt_out WHERE receipt_id = ?').run(receiptId);
  db.prepare('DELETE FROM polled_item WHERE receipt_id = ?').run(receiptId);
  db.prepare('DELETE FROM poll WHERE receipt_id = ?').run(receiptId); // cascades poll_voter
}

const memberByTelegramId = (db, telegramUserId) =>
  db.prepare('SELECT * FROM member WHERE telegram_user_id = ?').get(String(telegramUserId));

const household = (db, id) => db.prepare('SELECT * FROM household WHERE id = ?').get(id);

const householdByChatId = (db, chatId) =>
  db.prepare('SELECT * FROM household WHERE telegram_chat_id = ?').get(String(chatId));

const firstHousehold = (db) => db.prepare('SELECT * FROM household ORDER BY id LIMIT 1').get();

// writes

function addMember(db, householdId, { name, telegramHandle = null, telegramUserId = null }) {
  const taken = members(db, householdId).length;
  const info = db
    .prepare(
      'INSERT INTO member (household_id, name, initial, avatar_color, telegram_handle, telegram_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      householdId,
      name,
      [...name][0] ? [...name][0].toUpperCase() : '?',
      PALETTE[taken % PALETTE.length],
      telegramHandle,
      telegramUserId === null ? null : String(telegramUserId),
    );
  return db.prepare('SELECT * FROM member WHERE id = ?').get(info.lastInsertRowid);
}

function createHousehold(db, { name, telegramChatId = null }) {
  const info = db
    .prepare('INSERT INTO household (name, telegram_chat_id) VALUES (?, ?)')
    .run(name, telegramChatId);
  return household(db, info.lastInsertRowid);
}

function createReceipt(db, { householdId, store, grocerId, createdBy = null, createdAt = Math.floor(Date.now() / 1000) }) {
  const info = db
    .prepare('INSERT INTO receipt (household_id, store, created_at, grocer_id, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(householdId, store, createdAt, grocerId, createdBy);
  return receipt(db, info.lastInsertRowid);
}

function replaceItems(db, receiptId, rows) {
  const del = db.prepare('DELETE FROM item WHERE receipt_id = ?');
  const ins = db.prepare(
    'INSERT INTO item (receipt_id, name, price_cents, quantity, ai_flagged, ai_guess, position, item_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    del.run(receiptId);
    rows.forEach((r, i) =>
      ins.run(receiptId, r.name, r.priceCents, r.quantity ?? null, r.aiFlagged ? 1 : 0, r.aiGuess ?? null, i, r.itemCode ?? null),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return items(db, receiptId);
}

// Edit in place so opt-outs and poll rows (ON DELETE CASCADE from item) survive.
// An id belonging to THIS receipt updates that row; anything else inserts.
// Existing items in `knownIds` but missing from `rows` are deleted (their own opt-outs go with them).
function syncItems(db, receiptId, rows, knownIds) {
  const mine = new Set(items(db, receiptId).map((i) => i.id));
  const keep = new Set();
  const upd = db.prepare(
    'UPDATE item SET name = ?, price_cents = ?, quantity = ?, ai_flagged = ?, ai_guess = ?, position = ?, item_code = COALESCE(?, item_code) WHERE id = ? AND receipt_id = ?',
  );
  const ins = db.prepare(
    'INSERT INTO item (receipt_id, name, price_cents, quantity, ai_flagged, ai_guess, position, item_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    rows.forEach((r, i) => {
      const flat = [r.name, r.priceCents, r.quantity ?? null, r.aiFlagged ? 1 : 0, r.aiGuess ?? null, i];
      const code = r.itemCode ?? null; // omitted by older clients: an existing code is kept
      const id = Number(r.id);
      if (mine.has(id) && !keep.has(id)) {
        upd.run(...flat, code, id, receiptId);
        keep.add(id);
      } else {
        ins.run(receiptId, ...flat, code);
      }
    });
    const del = db.prepare('DELETE FROM item WHERE id = ? AND receipt_id = ?');
    // Only delete what the client could see; lines added meanwhile by someone else stay.
    for (const id of mine) if (!keep.has(id) && knownIds.includes(id)) del.run(id, receiptId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return items(db, receiptId);
}

module.exports = {
  open, PALETTE, SCHEMA, computeReceiptSplit, freezeSplit, syncItems,
  household, householdByChatId, firstHousehold,
  members, items, receipt, receipts, polledItems, optOuts, voters, polls, pollByTelegramId, clearPolls,
  memberByTelegramId,
  addMember, createHousehold, createReceipt, replaceItems,
};
