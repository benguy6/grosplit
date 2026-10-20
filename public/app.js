'use strict';

// GroSplit Mini App. Vanilla — the prototype was already HTML/CSS, and a
// framework would only translate it. One state object, one render, event
// delegation via data-act.

const TG = window.Telegram && window.Telegram.WebApp;
if (TG) {
  TG.ready();
  TG.expand();
  // The design brings its own back circles and sticky footers; Telegram's
  // BackButton/MainButton would compete with them.
  if (TG.BackButton) TG.BackButton.hide();
}

const app = document.getElementById('app');

const S = {
  screen: 'home',
  data: null,        // /api/state
  view: null,        // current receipt view
  selected: [],      // polled item ids (poll composer)
  editId: null,      // item being edited
  editSeen: null,    // {name, price} that sheet opened with, to spot someone else's edit
  confirmDelete: false,
  newSheet: false,
  payerSheet: false,   // review: change who paid
  confirmDeleteReceipt: false,
  confirmReplace: false,   // poll composer: replacing a poll that already ran
  grocerDraft: null,
  scanning: false,
  scanError: null,
  toast: null,
  colorFor: null,    // member id whose palette is open
  busy: false,
};

let toastTimer = null;
let liveTimer = null;

// ── plumbing ───────────────────────────────────────────────────────────────

async function api(method, path, body, raw) {
  const headers = {};
  if (TG && TG.initData) headers['x-telegram-initdata'] = TG.initData;
  let payload;
  if (raw) {
    headers['content-type'] = raw.type || 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // `code` lets the boot screen tell "not in the group" from a plain failure.
    const err = new Error((json && json.error) || 'Something went wrong');
    err.code = json && json.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cur = () => (S.data && S.data.household.currency) || '$';
const fmt = (cents) => cur() + (cents / 100).toFixed(2);
// Money inside Space Grotesk prose still has to be mono + tabular (SPEC §9).
const mono = (cents) => '<span class="mono-num">' + fmt(cents) + '</span>';
const upper = (s) => String(s || '').toUpperCase();

const memberById = (id) => (S.data ? S.data.members.find((m) => m.id === id) : null);
const meId = () => (S.data ? S.data.me.id : null);
const nameOf = (m) => (m.id === meId() ? m.name + ' (you)' : m.name);

function avatar(m, size, extra) {
  const s = size || 30;
  return `<div class="avatar" style="width:${s}px;height:${s}px;background:${esc(m.avatar_color)};font-size:${Math.round(s * 0.4)}px;${extra || ''}">${esc(m.initial)}</div>`;
}

function toast(msg) {
  S.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; render(); }, 2200);
  render();
  if (TG && TG.HapticFeedback) TG.HapticFeedback.notificationOccurred('success');
}

function stopLive() { clearInterval(liveTimer); liveTimer = null; }

// Sheets and armed confirmations belong to one screen of one receipt; never carry them over.
function resetTransient() {
  S.newSheet = false; S.payerSheet = false; S.editId = null;
  S.confirmDelete = false; S.confirmDeleteReceipt = false; S.confirmReplace = false; S.colorFor = null;
}

async function go(screen) {
  resetTransient();
  stopLive();
  S.screen = screen;
  S.scanError = null;
  render();
  if (screen === 'live' && !liveTimer) {
    // Votes arrive by webhook; the Mini App polls for them.
    liveTimer = setInterval(refreshView, 4000);
  }
  // Item-number lookups finish a few seconds after a scan; check back until they're done.
  if (screen === 'review' && S.view && S.view.lookupsPending > 0) liveTimer = setInterval(refreshReview, 3000);
}

// Re-GET before saving the item list: labels may have arrived since this screen loaded,
// and a payload built from the old view would wipe them. Assigns S.view without
// resetting sheets (loadReceipt would close the one being saved from).
async function freshen() {
  S.view = await api('GET', '/api/receipt/' + S.view.receipt.id);
}

// A receipt "has had a poll" once a poll row exists. State rows may only carry votedCount
// (voters only exist after a poll), so fall back to that until they carry pollCount too.
const hadPoll = (r) => (r.pollCount != null ? r.pollCount > 0 : (r.votedCount || 0) > 0);

async function refreshState() {
  S.data = await api('GET', '/api/state');
}

async function loadReceipt(id) {
  S.view = await api('GET', '/api/receipt/' + id);
  resetTransient();
  S.selected = S.view.polledItemIds.slice();
}

async function refreshReview() {
  if (S.screen !== 'review' || !S.view) return stopLive();
  try {
    const next = await api('GET', '/api/receipt/' + S.view.receipt.id);
    const sig = (v) => JSON.stringify([v.lookupsPending, v.items.map((i) => [i.id, i.name, i.ai_guess, i.ai_flagged, i.item_code])]);
    if (sig(next) !== sig(S.view) && !S.editId && !S.busy) { S.view = next; render(); }
    if (!next.lookupsPending) stopLive();
  } catch { /* transient; next tick retries */ }
}

async function refreshView() {
  if (!S.view) return;
  try {
    const before = S.view.voterIds.length;
    S.view = await api('GET', '/api/receipt/' + S.view.receipt.id);
    render();
    // Everyone (the payer too) has voted — nobody should have to babysit it.
    const total = S.view.members.length;
    if (S.screen === 'live' && S.view.voterIds.length >= total && before < total) {
      setTimeout(() => { if (S.screen === 'live') { stopLive(); go('confirm'); } }, 1500);
    }
  } catch { /* transient; the next tick retries */ }
}

async function act(fn) {
  if (S.busy) return;
  S.busy = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    S.busy = false;
    render();
  }
}

// The signature tick: recalculated numbers count up over 600ms.
const lastSeen = new Map();
function animateCounts() {
  for (const el of app.querySelectorAll('[data-count]')) {
    const key = el.getAttribute('data-count');
    const to = Number(el.getAttribute('data-cents'));
    const from = lastSeen.has(key) ? lastSeen.get(key) : to;
    lastSeen.set(key, to);
    if (from === to || !Number.isFinite(from)) continue;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// Saves the item list. knownIds = what this screen was showing, so the server only
// deletes lines we knew about; ones a housemate added meanwhile survive.
async function putItems(items) {
  const id = S.view.receipt.id;
  try {
    return await api('PUT', '/api/receipt/' + id + '/items', { items, knownIds: S.view.items.map((i) => i.id) });
  } catch (e) {
    if (e.code !== 'stale') throw e;
    // Someone else changed it: show the latest, drop our edit, say so.
    await loadReceipt(id);
    await refreshState();
    throw e; // act() toasts the server's message
  }
}

// B27: keys already animated, so the 4s refresh only fades in what's new.
const shown = new Set();
const fresh = (k) => { const n = !shown.has(k); shown.add(k); return n; };

// Same balanced chunking as the server: ≤ 9 per poll, 14 → 7+7, 20 → 7+7+6.
const POLL_MAX = 9;
function pollSizes(n) {
  if (!n) return [];
  const parts = Math.ceil(n / POLL_MAX);
  return Array.from({ length: parts }, (_, i) => Math.floor(n / parts) + (i < n % parts ? 1 : 0));
}

// ── flow strip ─────────────────────────────────────────────────────────────

const FLOW = [
  ['review', 'REVIEW'], ['poll', 'POLL'], ['live', 'VOTES'],
  ['confirm', 'SPLIT'], ['export', 'EXPORT'],
];

function flowStrip() {
  const at = FLOW.findIndex(([id]) => id === S.screen);
  const v = S.view;
  return `<div class="flow">${FLOW.map(([id, label], i) => {
    const cls = at === i ? 'now' : at > i ? 'done' : '';
    return `<button class="${cls}" data-act="flow" data-id="${id}"><span class="bar"></span><span class="step">${label}</span></button>`;
  }).join('')}</div>`;
  void v;
}

function flowReachable(id) {
  const v = S.view;
  if (!v) return false;
  if (id === 'review') return v.receipt.status === 'review';
  if (id === 'poll') return v.items.length > 0 && v.receipt.status === 'review';
  if (id === 'live') return v.receipt.status === 'polling' || v.receipt.status === 'posting' || v.polledItemIds.length > 0;
  if (id === 'confirm') return v.items.length > 0 && v.receipt.status !== 'posting';
  if (id === 'export') return v.receipt.status === 'confirmed';
  return false;
}

// ── screens ────────────────────────────────────────────────────────────────

function screenOnboarding() {
  const ms = S.data.members;
  return `<div class="screen" style="padding:78px 22px 40px">
    <div style="width:48px;height:48px;border-radius:15px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font:700 24px var(--ui)">G</div>
    <div class="display" style="margin-top:22px;text-wrap:pretty">Who's in the house?</div>
    <div class="body" style="margin-top:8px">Everyone splits everything by default. The Telegram poll is how people get out of things.</div>

    <div style="margin-top:26px;display:flex;flex-direction:column;gap:7px">
      <div class="label">Household</div>
      <div class="field" style="display:flex;align-items:center;border:1.5px solid var(--accent);box-shadow:0 0 0 4px var(--accent-soft)">${esc(S.data.household.name)}</div>
    </div>

    <div style="margin-top:22px;display:flex;flex-direction:column;gap:9px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div class="label">Members</div>
        <div class="meta">${ms.length} OF ${ms.length}</div>
      </div>
      <div class="card" style="border-radius:16px;overflow:hidden">
        ${ms.map((m) => `<div style="display:flex;align-items:center;gap:12px;min-height:56px;padding:0 15px;border-bottom:1px solid var(--line-soft)">
          ${avatar(m, 32)}
          <div style="flex:1;font:500 15px var(--ui)">${esc(m.name)}</div>
          <div class="meta">${m.id === meId() ? 'YOU' : ''}</div>
        </div>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-top:18px;display:flex;align-items:center;gap:12px;padding:14px 16px">
      <div style="width:34px;height:34px;border-radius:10px;background:var(--paper);display:flex;align-items:center;justify-content:center;font:500 15px var(--mono);color:var(--ink-60);flex:none">TG</div>
      <div style="flex:1;display:flex;flex-direction:column;gap:2px">
        <div style="font:500 14px var(--ui)">Telegram group ${S.data.household.telegram_chat_id ? 'linked' : 'not linked yet'}</div>
        <div class="meta" style="letter-spacing:normal">${S.data.household.telegram_chat_id ? 'BOT ACTIVE' : 'ADD THE BOT TO YOUR GROUP'}</div>
      </div>
      <div class="toggle ${S.data.household.telegram_chat_id ? 'on' : ''}"><span></span></div>
    </div>

    <div class="grow"></div>
    <button class="btn btn-primary" data-act="go" data-id="home">Start splitting</button>
  </div>`;
}

function receiptCard(r, settled) {
  const status = r.status === 'confirmed'
    ? { label: 'LOCKED', bg: 'var(--sage-soft)', color: '#2F6246', hint: 'Ready to copy into Tricount' }
    : r.status === 'posting'
      ? { label: 'SENDING POLL…', bg: 'var(--amber-soft)', color: 'var(--amber-text)', hint: 'Posting to the group, one moment' }
    : r.status === 'polling'
      ? { label: 'POLL OPEN', bg: 'var(--amber-soft)', color: 'var(--amber-text)', hint: r.votedCount + ' of ' + S.data.members.length + ' housemates have voted' }
      : hadPoll(r)
        ? { label: 'POLL CLOSED', bg: 'var(--sage-soft)', color: '#2F6246', hint: 'Votes are in — lock the split' }
        : { label: 'NEEDS REVIEW', bg: 'var(--accent-soft)', color: 'var(--accent-deep)', hint: 'Check the AI read it right' };
  const grocer = memberById(r.grocer_id);
  const when = new Date(r.created_at * 1000);
  const isToday = new Date().toDateString() === when.toDateString();
  const stamp = isToday
    ? 'TODAY ' + when.toTimeString().slice(0, 5)
    : upper(when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));

  if (settled) {
    return `<div class="receipt-wrap" style="opacity:.62"><button class="receipt" data-act="open" data-id="${r.id}" style="display:block;width:100%;padding:4px 18px 16px;text-align:left">
      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding-bottom:10px;border-bottom:1px dashed var(--dot)">
        <div class="store-name">${esc(upper(r.store))}</div>
        <div class="meta">${stamp} · ${r.itemCount} ITEMS · BY ${esc(upper(grocer ? grocer.name : '?'))}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding-top:11px">
        <div style="font:500 11px var(--mono);letter-spacing:.08em;color:var(--ink-60)">SETTLED · IN TRICOUNT</div>
        <div style="font:700 22px var(--mono);font-variant-numeric:tabular-nums;color:var(--ink-40)">${fmt(r.totalCents)}</div>
      </div>
    </button></div>`;
  }

  return `<div class="receipt-wrap"><button class="receipt" data-act="open" data-id="${r.id}" style="display:block;width:100%;padding:4px 18px 18px;text-align:left">
    <div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding-bottom:11px;border-bottom:1px dashed var(--dot)">
      <div class="store-name">${esc(upper(r.store))}</div>
      <div class="meta">${stamp} · ${r.itemCount} ITEMS · BY ${esc(upper(grocer ? grocer.name : '?'))}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;padding-top:12px">
      <div class="leader"><span>SUBTOTAL</span><span class="leader-fill"></span><span>${fmt(r.subtotalCents)}</span></div>
      <div class="leader"><span>TAX</span><span class="leader-fill"></span><span>${fmt(r.tax_enabled ? r.tax_cents : 0)}</span></div>
    </div>
    <div class="total-block" style="margin-top:12px">
      <div style="font:500 12px var(--mono);letter-spacing:.1em">TOTAL PAID</div>
      <div class="money-lg">${fmt(r.totalCents)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px">
      <div style="font:400 11px/1.45 var(--mono);color:var(--ink-60);max-width:180px;text-wrap:pretty">${status.hint}</div>
      <div style="padding:5px 10px;background:${status.bg};color:${status.color};font:500 10.5px var(--mono);letter-spacing:.08em;white-space:nowrap">${status.label}</div>
    </div>
  </button></div>`;
}

function screenHome() {
  const rs = S.data.receipts;
  const active = rs.filter((r) => r.status !== 'confirmed');
  const settled = rs.filter((r) => r.status === 'confirmed');
  const ms = S.data.members;
  const now = new Date();
  const thisMonth = rs.filter((r) => {
    const dt = new Date(r.created_at * 1000);
    return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
  });
  const spend = thisMonth.reduce((s, r) => s + r.totalCents, 0);

  return `<div class="screen">
    <div style="padding:max(44px,env(safe-area-inset-top)) var(--gutter) 14px;display:flex;align-items:flex-end;justify-content:space-between">
      <div style="display:flex;flex-direction:column;gap:2px">
        <div class="meta">${esc(upper(S.data.household.name))}</div>
        <div class="display">Receipts</div>
      </div>
      <div style="display:flex">
        ${ms.slice(0, 3).map((m, i) => avatar(m, 30, `border:2px solid var(--paper);${i ? 'margin-left:-9px' : ''}`)).join('')}
        ${ms.length > 3 ? `<div class="avatar" style="width:30px;height:30px;background:var(--paper);border:1px solid #DDD6CA;color:var(--ink-60);font-size:11px;margin-left:-9px">+${ms.length - 3}</div>` : ''}
      </div>
    </div>

    <div style="padding:0 var(--gutter);display:flex;flex-direction:column;gap:3px">
      ${active.length === 0 && settled.length === 0
        ? `<div class="card" style="padding:28px 20px;text-align:center;display:flex;flex-direction:column;gap:8px">
             <div class="title">No receipts yet</div>
             <div class="body">Tap + when you get back from the shop.</div>
           </div>`
        : ''}
      ${active.map((r) => receiptCard(r, false)).join('')}
      ${settled.slice(0, 1).map((r) => receiptCard(r, true)).join('')}
    </div>

    ${thisMonth.length ? `<div style="padding:26px var(--gutter) 0;display:flex;flex-direction:column;gap:10px">
      <div class="meta">THIS MONTH</div>
      <div style="display:flex;gap:12px">
        <div class="card" style="flex:1;padding:15px;display:flex;flex-direction:column;gap:5px">
          <div style="font:700 24px var(--mono);letter-spacing:-0.02em">${fmt(spend)}</div>
          <div style="font:400 11.5px var(--ui);color:var(--ink-60)">across ${thisMonth.length} shop${thisMonth.length === 1 ? '' : 's'}</div>
        </div>
        <div class="card" style="flex:1;padding:15px;display:flex;flex-direction:column;gap:5px">
          <div style="font:700 24px var(--mono);letter-spacing:-0.02em">${fmt(Math.round(spend / ms.length))}</div>
          <div style="font:400 11.5px var(--ui);color:var(--ink-60)">avg. per person</div>
        </div>
      </div>
    </div>` : ''}

    <div class="grow" style="min-height:48px"></div>
    ${tabbar('home')}
  </div>`;
}

function tabbar(which) {
  return `<div class="tabbar">
    <button class="tab ${which === 'home' ? 'on' : ''}" data-act="go" data-id="home">
      <span class="glyph" style="border-radius:5px"></span><span class="name">Receipts</span>
    </button>
    <button class="fab" data-act="new-sheet">+</button>
    <button class="tab ${which === 'house' ? 'on' : ''}" data-act="go" data-id="house">
      <span class="glyph" style="border-radius:999px"></span><span class="name">House</span>
    </button>
  </div>`;
}

function screenScan() {
  const v = S.view;
  return `<div class="screen" style="background:var(--ink);padding:max(44px,env(safe-area-inset-top)) 0 40px">
    <div style="padding:0 var(--gutter);display:flex;align-items:center;justify-content:space-between">
      <button data-act="go" data-id="home" style="width:38px;height:38px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px">&larr;</button>
      <div style="font:500 13px var(--ui);color:#fff">${esc(v.receipt.store)}</div>
      <div style="width:38px"></div>
    </div>

    <div style="margin:20px;flex:1;border-radius:22px;background:#2A2622;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(180deg,#37322D 0 3px,#2E2A25 3px 22px)"></div>
      <div style="position:absolute;left:26px;right:26px;top:44px;bottom:44px;border:2px dashed rgba(255,255,255,.28);border-radius:14px"></div>
      ${S.scanning ? '<div style="position:absolute;left:26px;right:26px;height:3px;background:var(--accent);box-shadow:0 0 22px 5px rgba(232,85,45,.55);animation:gsScan 1.1s cubic-bezier(.4,0,.6,1) infinite alternate"></div>' : ''}
      <div style="position:relative;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center;padding:0 30px">
        <div style="font:500 12px var(--mono);letter-spacing:.08em;color:rgba(255,255,255,.65)">${S.scanning ? 'READING RECEIPT…' : S.scanError ? "COULDN'T READ THAT" : 'LINE UP THE RECEIPT'}</div>
        <div style="font:400 13px/1.5 var(--ui);color:rgba(255,255,255,.42);text-wrap:pretty">${S.scanning
          ? 'Finding items, prices and tax'
          : S.scanError
            ? esc(S.scanError) + ' — try again, or enter it by hand.'
            : 'Flat surface, all lines visible. Long receipts are fine — just keep scrolling.'}</div>
      </div>
    </div>

    <div style="padding:0 var(--gutter);display:flex;align-items:center;justify-content:space-between">
      <button data-act="go" data-id="manual" style="padding:11px 16px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font:500 13px var(--ui)">Enter manually</button>
      <label style="width:70px;height:70px;border-radius:999px;border:3px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;cursor:pointer">
        <span style="width:56px;height:56px;border-radius:999px;background:var(--accent);display:block"></span>
        <input type="file" accept="image/*" capture="environment" data-act="shoot" style="display:none" ${S.scanning ? 'disabled' : ''}>
      </label>
      <label style="padding:11px 16px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font:500 13px var(--ui);cursor:pointer">
        Upload<input type="file" accept="image/*" data-act="shoot" style="display:none" ${S.scanning ? 'disabled' : ''}>
      </label>
    </div>
  </div>`;
}

function screenReview() {
  const v = S.view;
  const flags = v.items.filter((i) => i.ai_flagged);
  const taxOn = !!v.receipt.tax_enabled;
  const mismatch = v.reconcile && v.reconcile.deltaCents !== 0;
  const closedPoll = v.receipt.status === 'review' && v.pollCount > 0;

  return `<div class="screen">
    <div class="sticky-head">
      ${flowStrip()}
      <div style="display:flex;align-items:center;gap:12px;margin-top:11px">
        <button class="back" data-act="go" data-id="home">&larr;</button>
        <div style="flex:1;display:flex;flex-direction:column;gap:1px">
          <div class="title">Review ${v.items.length} item${v.items.length === 1 ? '' : 's'}</div>
          <div class="meta" style="letter-spacing:normal">${esc(upper(v.receipt.store))}</div>
        </div>
        <div style="font:700 20px var(--mono);font-variant-numeric:tabular-nums" data-count="review-total" data-cents="${v.split.totalCents}">${fmt(v.split.totalCents)}</div>
      </div>
      ${closedPoll ? `<div class="banner" style="margin-top:11px;background:var(--sage-soft);border-color:var(--sage-muted);color:#2F6246">
        <span style="flex:1">Poll closed · ${v.voterIds.length} voted · <span style="white-space:nowrap">${v.optOuts.length} opt-out${v.optOuts.length === 1 ? '' : 's'}</span></span>
        <button data-act="go" data-id="confirm" style="font:600 12px var(--ui);color:#2F6246;text-decoration:underline">See the split &rarr;</button>
      </div>` : ''}
      ${flags.length ? `<div class="banner" style="margin-top:11px">
        <span style="font:700 13px var(--mono);color:var(--amber-text)">!</span>
        <span style="flex:1">${flags.length === 1 ? "1 name the AI wasn't sure about" : flags.length + " names the AI wasn't sure about"}</span>
        <button data-act="fix-all" style="font:500 12px var(--ui);color:var(--amber-text);text-decoration:underline">Fix all</button>
      </div>` : ''}
      ${v.lookupsPending > 0 ? `<div style="margin-top:9px;font:400 12.5px var(--ui);color:var(--ink-60)">Looking up ${v.lookupsPending} item number${v.lookupsPending === 1 ? '' : 's'}…</div>` : ''}
      ${mismatch ? `<div class="banner" style="margin-top:8px">
        <span style="font:700 13px var(--mono);color:var(--amber-text)">!</span>
        <span style="flex:1">These lines come to ${mono(v.split.totalCents)}, but the receipt says ${mono(v.reconcile.printedCents)}.</span>
      </div>` : ''}
    </div>

    <div style="padding:12px var(--gutter) 0;display:flex;flex-direction:column;gap:8px">
      ${v.items.length === 0 ? `<div class="card" style="padding:24px;text-align:center"><div class="body">Nothing on this receipt yet.</div></div>` : ''}
      ${v.items.map((it) => {
        const f = !!it.ai_flagged;
        const each = Math.round(it.price_cents / v.members.length);
        return `<button class="item-row ${f ? 'flagged' : ''}" data-act="edit" data-id="${it.id}">
          <span class="box ${f ? 'amber' : ''}">${f ? '?' : '✓'}</span>
          <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;text-align:left">
            <span style="font:500 15px var(--ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}${it.quantity ? ' ×' + it.quantity : ''}</span>
            <span style="font:400 11px var(--mono);letter-spacing:.03em;color:${f ? 'var(--amber-text)' : 'var(--ink-40)'}">${(it.item_code ? '#' + esc(it.item_code) + ' · ' : '') + (f ? 'AI UNSURE · TAP TO FIX THE NAME' : 'SPLIT ' + v.members.length + ' WAYS · ' + fmt(each) + ' EA')}</span>
          </span>
          <span class="money">${fmt(it.price_cents)}</span>
          <span class="pill" style="padding:6px 10px;font:500 11px var(--ui);color:var(--ink-60);background:var(--paper)">Edit</span>
        </button>`;
      }).join('')}

      <button data-act="go" data-id="manual" style="height:48px;border-radius:12px;border:1.5px dashed var(--dot);display:flex;align-items:center;justify-content:center;gap:8px;font:500 14px var(--ui);color:var(--ink-60);margin-top:2px;width:100%">+ Add an item</button>

      <div class="card" style="margin-top:14px;padding:16px;display:flex;flex-direction:column;gap:13px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;font:400 13.5px var(--ui);color:var(--ink-60)">
          <span>Subtotal</span><span class="money" style="font-size:14px;color:var(--ink)">${fmt(v.split.subtotalCents)}</span>
        </div>
        <div class="divider"></div>
        <div style="display:flex;align-items:center;gap:12px">
          <div style="flex:1;display:flex;flex-direction:column;gap:2px">
            <div style="font:500 14px var(--ui)">Split the tax too</div>
            <div style="font:400 10.5px var(--mono);letter-spacing:.03em;color:var(--ink-40)">${taxOn ? 'READ OFF RECEIPT' : 'NOT SPLIT · GROCER ABSORBS IT'}</div>
          </div>
          <button class="money" data-act="edit-tax" style="font-size:14px;text-decoration:underline;text-underline-offset:3px">${fmt(v.receipt.tax_cents)}</button>
          <button class="toggle ${taxOn ? 'on' : ''}" data-act="toggle-tax"><span></span></button>
        </div>
        ${taxOn ? `<div style="display:flex;flex-direction:column;gap:8px">
          <div style="height:38px;border-radius:11px;background:var(--paper);padding:4px;display:flex;gap:4px">
            <button data-act="tax-mode" data-id="pro" style="flex:1;border-radius:8px;font:500 12.5px var(--ui);${v.receipt.tax_mode === 'pro' ? 'background:var(--card)' : 'color:var(--ink-60)'}">By share</button>
            <button data-act="tax-mode" data-id="even" style="flex:1;border-radius:8px;font:500 12.5px var(--ui);${v.receipt.tax_mode === 'even' ? 'background:var(--card)' : 'color:var(--ink-60)'}">${v.members.length} ways</button>
          </div>
          <div style="font:400 12px var(--ui);color:var(--ink-60)">${v.receipt.tax_mode === 'even'
            ? mono(Math.round(v.receipt.tax_cents / v.members.length)) + ' of tax each, flat.'
            : 'Tax follows what each person actually owes.'}</div>
        </div>` : ''}
        <div class="divider"></div>
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span style="font:600 15px var(--ui)">Total</span>
          <span style="font:700 22px var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-0.02em">${fmt(v.split.totalCents)}</span>
        </div>
      </div>
      ${manageBlock(v)}
    </div>

    <div class="grow"></div>
    <div class="sticky-foot">
      <div style="display:flex;justify-content:space-between;font:500 12.5px var(--ui);color:var(--ink-60)">
        <span>Everyone in on everything</span><span style="font-family:var(--mono)">${fmt(v.evenShareCents)} each</span>
      </div>
      ${closedPoll ? `<button class="btn btn-primary" data-act="go" data-id="confirm">See the split</button>
      <button class="btn btn-quiet" data-act="go" data-id="poll">Run a new poll</button>` : `<button class="btn btn-primary" data-act="go" data-id="poll" ${v.items.length ? '' : 'disabled'}>
        <span style="font:500 12px var(--mono);color:rgba(255,255,255,.7)">TG</span>Send poll to the group
      </button>
      <button class="btn btn-quiet" data-act="go" data-id="confirm">Skip the poll — split ${v.members.length} ways</button>`}
    </div>
  </div>`;
}

// Review only: who paid (everyone sees; creator/grocer can change) and delete.
function manageBlock(v) {
  const g = v.members.find((m) => m.id === v.receipt.grocer_id);
  if (!g) return '';
  const row = `<div style="display:flex;align-items:center;gap:10px;font:400 13.5px var(--ui);color:var(--ink-60)">
      ${avatar(g, 22)}<span style="flex:1">Paid by <b style="font-weight:600;color:var(--ink)">${esc(g.id === meId() ? 'you' : g.name)}</b></span>
      ${v.canManage ? '<button class="pill" data-act="payer-sheet" style="padding:6px 12px;font:500 12px var(--ui);background:var(--paper)">Change</button>' : ''}
    </div>`;
  if (!v.canManage) return `<div style="margin-top:14px;padding:0 4px">${row}</div>`;
  const del = S.confirmDeleteReceipt
    ? `<div style="padding:15px;border-radius:14px;background:var(--accent-soft);border:1px solid var(--danger-border);display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="font:600 15px var(--ui);color:var(--accent-deep)">Delete this receipt?</div>
          <div style="font:400 12.5px/1.45 var(--ui);color:#A0543A;text-wrap:pretty">${esc(v.receipt.store)} and its ${v.items.length} line${v.items.length === 1 ? '' : 's'} go for good. Nobody is asked to pay anything.</div>
        </div>
        <div style="display:flex;gap:10px">
          <button data-act="cancel-del-receipt" style="flex:1;height:46px;border-radius:12px;background:var(--card);border:1px solid var(--danger-border);font:600 15px var(--ui);color:var(--ink-60)">Keep it</button>
          <button data-act="del-receipt" style="flex:1;height:46px;border-radius:12px;background:var(--danger);color:#fff;font:600 15px var(--ui)">Delete</button>
        </div>
      </div>`
    : '<button data-act="ask-del-receipt" style="align-self:flex-start;min-height:44px;padding:0 4px;font:500 13.5px var(--ui);color:var(--danger)">Delete receipt</button>';
  return `<div style="margin-top:14px;padding:0 4px;display:flex;flex-direction:column;gap:6px">${row}${del}</div>`;
}

function screenManual() {
  return `<div class="screen" style="padding:max(44px,env(safe-area-inset-top)) var(--gutter) 40px">
    <div style="display:flex;align-items:center;gap:12px">
      <button class="back" data-act="go" data-id="review">&larr;</button>
      <div class="title">Add item</div>
    </div>
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;flex-direction:column;gap:7px">
        <div class="label">Item name</div>
        <input class="field" id="draft-name" placeholder="What is it?" autocomplete="off">
      </div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <div class="label">Price</div>
        <div class="field" style="display:flex;align-items:center;gap:6px">
          <span style="font:500 15px var(--mono);color:var(--ink-40)">${cur()}</span>
          <input id="draft-price" inputmode="decimal" placeholder="0.00" style="flex:1;border:none;background:transparent;outline:none;font:500 19px var(--mono);font-variant-numeric:tabular-nums;width:100%">
        </div>
        <div style="font:400 11.5px var(--ui);color:var(--ink-40)">Negative for a coupon or discount.</div>
      </div>
    </div>
    <div class="grow"></div>
    <button class="btn btn-primary" data-act="add-item">Add to receipt</button>
  </div>`;
}

// Re-polling wipes the old votes (B14); say so before it happens.
function replacePanel(v) {
  const people = new Set(v.optOuts.map((o) => o.memberId)).size;
  return `<div style="padding:15px;border-radius:14px;background:var(--accent-soft);border:1px solid var(--danger-border);display:flex;flex-direction:column;gap:12px">
    <div style="display:flex;flex-direction:column;gap:3px">
      <div style="font:600 15px var(--ui);color:var(--accent-deep)">Send a new poll?</div>
      <div style="font:400 12.5px/1.45 var(--ui);color:#A0543A;text-wrap:pretty">This replaces the old poll and clears ${v.optOuts.length} opt-out${v.optOuts.length === 1 ? '' : 's'} from ${people} ${people === 1 ? 'person' : 'people'}.</div>
    </div>
    <div style="display:flex;gap:10px">
      <button data-act="keep-votes" style="flex:1;height:46px;border-radius:12px;background:var(--card);border:1px solid var(--danger-border);font:600 15px var(--ui);color:var(--ink-60)">Keep the votes</button>
      <button data-act="replace-poll" style="flex:1;height:46px;border-radius:12px;background:var(--danger);color:#fff;font:600 15px var(--ui)">Replace</button>
    </div>
  </div>`;
}

function screenPoll() {
  const v = S.view;
  const sizes = pollSizes(S.selected.length);
  const picked = v.items.filter((i) => S.selected.includes(i.id));
  const bubble = (n) => {
    const from = sizes.slice(0, n).reduce((a, b) => a + b, 0);
    const part = picked.slice(from, from + sizes[n]);
    const title = sizes.length > 1 ? ' — ' + (n + 1) + ' of ' + sizes.length : '';
    const row = (txt, tick) => `<div style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;background:var(--fill-hover)">
            <span style="width:16px;height:16px;border-radius:999px;border:1.5px solid var(--dash);flex:none"></span>
            <span style="flex:1;font:400 13px var(--ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap${tick ? ';color:var(--ink-60)' : ''}">${txt}</span>
          </div>`;
    return `<div class="card" style="border-radius:16px 16px 16px 6px;padding:15px;display:flex;flex-direction:column;gap:10px">
        <div style="font:500 14px/1.45 var(--ui)">🛒 ${esc(v.receipt.store)} · ${mono(v.split.totalCents)}${title}<br>Tick anything you're NOT in on. Closes in ${S.data.household.poll_window_hours}h.</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${part.map((i) => row(esc(i.name) + ' — ' + mono(i.price_cents))).join('')}
          ${row('✅ I\u2019m in on all of these', true)}
        </div>
        <div style="font:400 11px var(--mono);color:var(--ink-40)">MULTI-SELECT · ANONYMOUS: OFF</div>
      </div>`;
  };
  return `<div class="screen">
    <div class="sticky-head" style="display:flex;flex-direction:column;gap:11px">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="back" data-act="go" data-id="home">&larr;</button>
        <div style="flex:1;display:flex;flex-direction:column;gap:1px">
          <div class="title">Anything worth a poll?</div>
          <div class="meta" style="letter-spacing:normal">OPTIONAL · ${S.selected.length} PICKED</div>
        </div>
        <button class="pill" data-act="select-all" style="font:500 10px var(--mono);letter-spacing:.06em;padding:8px 11px">${S.selected.length ? 'CLEAR ALL' : 'SELECT ALL ' + v.items.length}</button>
      </div>
      ${flowStrip()}
    </div>

    <div style="padding:14px var(--gutter) 0;font:400 13px/1.5 var(--ui);color:var(--ink-60);text-wrap:pretty">
      Default is simple: everyone pays for everything. Only pick the items where someone might reasonably want out — those go into a Telegram poll.
    </div>
    ${sizes.length > 1 ? `<div style="padding:10px var(--gutter) 0;font:500 12.5px/1.45 var(--ui);color:var(--amber-text-deep)">That's ${sizes.length} polls of up to 9 items. Fewer picks is kinder to the group.</div>` : ''}

    <div style="padding:14px var(--gutter) 0;display:flex;flex-direction:column;gap:8px">
      ${v.items.map((it) => {
        const sel = S.selected.includes(it.id);
        return `<button class="item-row ${sel ? 'picked' : ''}" data-act="pick" data-id="${it.id}" style="border-left-width:1px">
          <span class="box ${sel ? '' : 'empty'}">${sel ? '✓' : ''}</span>
          <span style="flex:1;font:500 15px var(--ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left">${esc(it.name)}</span>
          <span class="money" style="font-size:15px;color:var(--ink-60)">${fmt(it.price_cents)}</span>
        </button>`;
      }).join('')}
    </div>

    ${S.selected.length ? `<div style="padding:22px var(--gutter) 0;display:flex;flex-direction:column;gap:9px">
      <div class="meta">TELEGRAM PREVIEW</div>
      ${bubble(0)}
      ${sizes.length > 1 ? `<div style="font:400 11.5px var(--mono);color:var(--ink-60);padding:0 4px">+ ${sizes.length - 1} more poll${sizes.length > 2 ? 's' : ''} (${S.selected.length - sizes[0]} items)</div>` : ''}
    </div>` : ''}

    <div class="grow"></div>
    <div class="sticky-foot">
      ${S.confirmReplace ? replacePanel(v) : ''}
      <button class="btn btn-primary" data-act="send-poll" ${S.confirmReplace ? 'style="display:none"' : ''} ${S.selected.length && sizes.length <= 15 ? '' : 'disabled'}>
        ${sizes.length > 15 ? 'Too many for 15 polls — pick fewer' : S.selected.length ? 'Post ' + (sizes.length > 1 ? sizes.length + ' polls' : 'poll') + ' to the group' : 'Pick at least one item'}
      </button>
      <button class="btn btn-quiet" data-act="go" data-id="confirm">Skip — split ${v.members.length} ways</button>
    </div>
  </div>`;
}

function screenLive() {
  const v = S.view;
  const voters = v.members; // the payer votes like everyone else
  const votedCount = v.voterIds.length;
  const allIn = votedCount >= voters.length;
  const closesIn = v.receipt.poll_closes_at
    ? Math.max(0, v.receipt.poll_closes_at - Math.floor(Date.now() / 1000))
    : null;
  const closesLabel = closesIn === null ? '' :
    ' · CLOSES IN ' + Math.floor(closesIn / 3600) + 'H ' + Math.floor((closesIn % 3600) / 60) + 'M';

  const rid = v.receipt.id;
  const sending = v.receipt.status === 'posting';
  const closed = v.receipt.status !== 'polling' && v.receipt.status !== 'posting';
  const many = (v.pollCount || 1) > 1 && Array.isArray(v.polls) && v.polls.length > 1;
  const polled = v.items.filter((i) => v.polledItemIds.includes(i.id));
  const groups = many
    ? v.polls.map((p) => ({ part: p.part, items: polled.filter((i) => p.itemIds.includes(i.id)) }))
    : [{ part: 1, items: polled }];
  const card = (it) => {
        const outs = v.optOuts.filter((o) => o.itemId === it.id).map((o) => memberById(o.memberId)).filter(Boolean);
        const inCount = v.members.length - outs.length;
        return `<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
            <div style="font:500 15px var(--ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</div>
            <div class="money" style="font-size:15px">${fmt(it.price_cents)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:9px">
            <div style="display:flex">${outs.map((m) => avatar(m, 24, 'border:2px solid var(--card);margin-left:-6px;' + (fresh(rid + 'o' + it.id + 'm' + m.id) ? 'animation:gsIn .25s ease both' : ''))).join('')}</div>
            <div style="flex:1;font:400 11.5px var(--mono);color:${outs.length ? 'var(--accent-deep)' : 'var(--ink-40)'}">${outs.length ? esc(outs.map((m) => m.name).join(', ')) + ' out' : 'everyone still in'}</div>
            <div style="font:500 12px var(--mono);color:var(--ink-60)" data-count="ea-${it.id}" data-cents="${Math.round(it.price_cents / Math.max(1, inCount))}">${fmt(Math.round(it.price_cents / Math.max(1, inCount)))} EA</div>
          </div>
        </div>`;
  };
  return `<div class="screen">
    <div class="sticky-head" style="display:flex;flex-direction:column;gap:11px">
      ${flowStrip()}
      <div style="display:flex;align-items:center;gap:12px">
        <button class="back" data-act="go" data-id="home">&larr;</button>
        <div style="flex:1;display:flex;flex-direction:column;gap:1px">
          <div class="title">${closed ? 'Poll closed' : 'Poll is live'}</div>
          <div class="meta" style="letter-spacing:normal">${votedCount} OF ${voters.length} VOTED${sending ? ' · SENDING POLL…' : closed ? '' : closesLabel}</div>
        </div>
      </div>
    </div>

    <div style="padding:16px var(--gutter) 0;display:flex;flex-direction:column;gap:11px">
      <div style="display:flex;gap:6px">
        ${voters.map((m) => {
          const voted = v.voterIds.includes(m.id);
          const done = (v.voteProgress && v.voteProgress[m.id]) || 0;
          const partial = !voted && done > 0;
          const outs = v.optOuts.filter((o) => o.memberId === m.id).length;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 2px;border-radius:12px;background:${voted ? 'var(--card)' : '#F1EDE5'};border:1px solid ${voted ? 'var(--line)' : '#E7E2D9'};${voted && fresh(rid + 'v' + m.id) ? 'animation:gsIn .3s ease both' : ''}">
            <div class="avatar" style="width:30px;height:30px;background:${voted || partial ? esc(m.avatar_color) : 'var(--dash)'};font-size:12px">${esc(m.initial)}</div>
            <div style="font:500 10px var(--mono);color:${voted || partial ? 'var(--ink-60)' : 'var(--ink-25)'}">${voted ? (outs ? outs + ' OUT' : 'ALL IN') : partial ? done + '/' + v.pollCount : '…'}</div>
            ${m.id === v.receipt.grocer_id ? '<div style="font:500 8px var(--mono);letter-spacing:.06em;color:var(--ink-meta);margin-top:-3px">PAID</div>' : ''}
          </div>`;
        }).join('')}
      </div>

      <div class="meta" style="margin-top:6px">OPT-OUTS COMING IN</div>
      ${groups.filter((g) => g.items.length).map((g) => (many ? `<div class="meta" style="margin-top:4px">POLL ${g.part} OF ${v.pollCount}</div>` : '') + g.items.map(card).join('')).join('')}
    </div>

    <div class="grow"></div>
    <div class="sticky-foot">
      <div style="font:400 12px var(--ui);color:var(--ink-60);text-align:center">${closed ? 'Poll closed. Anyone who didn\u2019t vote stayed in.' : allIn
        ? 'Everyone voted — opening the split…'
        : 'Waiting on ' + (voters.length - votedCount) + ' of ' + voters.length + '. Anyone who never votes stays in.'}</div>
      <button class="btn ${allIn || closed ? 'btn-primary' : 'btn-ink'}" data-act="${closed ? 'go" data-id="confirm' : 'close-poll'}" ${sending ? 'disabled' : ''}>${allIn || closed ? 'See the split' : 'Close poll early · ' + votedCount + '/' + voters.length + ' in'}</button>
    </div>
  </div>`;
}

function screenConfirm() {
  const v = S.view;
  const grocer = memberById(v.receipt.grocer_id) || v.members.find((m) => m.id === v.receipt.grocer_id);
  const isMe = v.receipt.grocer_id === meId();
  const owed = v.split.owedCents;
  const polled = v.polledItemIds.length;

  return `<div class="screen">
    <div class="sticky-head" style="display:flex;flex-direction:column;gap:11px">
      ${flowStrip()}
      <div style="display:flex;align-items:center;gap:12px">
        <button class="back" data-act="go" data-id="home">&larr;</button>
        <div style="flex:1;display:flex;flex-direction:column;gap:1px">
          <div class="title">The split</div>
          <div class="meta" style="letter-spacing:normal">${polled
            ? v.voterIds.length + ' VOTED · ' + polled + ' ITEMS POLLED'
            : 'NO POLL · EVERYONE IN ON ALL ' + v.items.length}</div>
        </div>
      </div>
    </div>

    <div style="padding:18px var(--gutter) 0;display:flex;flex-direction:column;gap:21px">
      <div style="background:var(--ink);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:6px">
        <div style="font:500 11px var(--mono);letter-spacing:.06em;color:var(--ink-40)">${isMe ? 'YOU PAID' : esc(upper(grocer.name)) + ' PAID'}</div>
        <div class="money-hero" style="color:var(--card)" data-count="hero" data-cents="${v.split.totalCents}">${fmt(v.split.totalCents)}</div>
        <div style="font:400 13px var(--ui);color:#B7B0A5">Owed back by ${v.members.length - 1} housemates: ${mono(owed)}</div>
        <div style="margin-top:8px;padding-top:10px;border-top:1px solid rgba(255,253,248,.14);display:flex;justify-content:space-between;font:500 11px var(--mono);letter-spacing:.04em;color:var(--ink-40)">
          <span>SUBTOTAL ${fmt(v.split.subtotalCents)}</span>
          <span>${v.receipt.tax_enabled ? 'TAX ' + fmt(v.split.taxCents) + (v.receipt.tax_mode === 'even' ? ' · EVEN' : ' · BY SHARE') : 'TAX NOT SPLIT'}</span>
        </div>
      </div>

      <div class="receipt-wrap"><div class="receipt" style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">
        <div style="text-align:center;font:500 11px var(--mono);letter-spacing:.14em;color:var(--ink-40);padding-bottom:10px;border-bottom:1px dashed var(--dot)">WHO OWES WHAT</div>
        ${v.members.map((m) => {
          const sh = v.split.shares[m.id];
          const isGrocer = m.id === v.receipt.grocer_id;
          return `<div style="display:flex;flex-direction:column;gap:3px">
            <div style="display:flex;align-items:baseline;gap:8px">
              ${avatar(m, 22, 'align-self:center')}
              <div style="font:500 13.5px var(--mono);letter-spacing:.02em">${esc(upper(m.name))}${m.id === meId() ? ' (YOU)' : ''}</div>
              ${isGrocer ? '<div style="padding:2px 7px;background:var(--paper);font:500 9px var(--mono);letter-spacing:.08em;color:var(--ink-60)">GROCER</div>' : ''}
              <div class="leader-fill"></div>
              <div style="font:600 17px var(--mono);font-variant-numeric:tabular-nums;color:${isGrocer ? 'var(--ink-40)' : 'var(--ink)'}" data-count="share-${m.id}" data-cents="${sh.cents}">${fmt(sh.cents)}</div>
            </div>
            <div style="padding-left:30px;font:400 11px var(--mono);letter-spacing:.04em;color:var(--ink-meta)">${isGrocer
              ? sh.itemCount + ' OF ' + v.items.length + ' ITEMS · PAID ' + fmt(v.split.totalCents) + ' · KEEPS THE ROUNDING'
              : sh.itemCount + ' OF ' + v.items.length + ' ITEMS' + (v.receipt.tax_enabled ? ' · +' + fmt(sh.taxCents) + ' TAX' : '')}</div>
          </div>`;
        }).join('')}
        <div style="margin-top:2px;border-top:1px dashed var(--dot);border-bottom:3px double var(--dash);padding:9px 0;display:flex;justify-content:space-between;font:500 11.5px var(--mono);letter-spacing:.08em">
          <span>SUM OF SHARES</span><span>${fmt(v.split.totalCents)}</span>
        </div>
      </div></div>
    </div>

    <div class="grow"></div>
    <div class="sticky-foot">
      <div style="font:400 12px/1.45 var(--ui);color:var(--ink-60);text-align:center;text-wrap:pretty">${isMe
        ? 'Only you can lock this — you did the shopping.'
        : 'Only ' + esc(grocer.name) + ' can lock this — they did the shopping.'}</div>
      <button class="btn ${isMe ? 'btn-sage' : 'btn-muted'}" data-act="lock" ${v.receipt.status === 'posting' ? 'disabled' : ''}>
        <span style="font:700 15px var(--ui)">${isMe ? '✓' : '⏳'}</span>${v.receipt.status === 'posting' ? 'Polls are still being sent' : isMe ? 'Confirm & lock split' : 'Waiting on ' + esc(grocer.name) + ' to confirm'}
      </button>
    </div>
  </div>`;
}

function screenExport() {
  const v = S.view;
  const grocer = v.members.find((m) => m.id === v.receipt.grocer_id);
  const others = v.members.filter((m) => m.id !== v.receipt.grocer_id);
  const when = new Date(v.receipt.created_at * 1000);
  return `<div class="screen">
    <div class="sticky-head" style="display:flex;flex-direction:column;gap:11px">
      ${flowStrip()}
      <div style="display:flex;align-items:center;gap:12px">
        <button class="back" data-act="go" data-id="home">&larr;</button>
        <div style="flex:1;display:flex;flex-direction:column;gap:1px">
          <div class="title">Put it in Tricount</div>
          <div class="meta" style="letter-spacing:normal">LOCKED · ${esc(upper(v.receipt.store))}</div>
        </div>
      </div>
    </div>

    <div style="padding:18px var(--gutter) 0;display:flex;flex-direction:column;gap:12px">
      <div class="card" style="border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px">
        <div class="meta">TRICOUNT ENTRY</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${[
            ['Title', esc(v.receipt.store) + ' · ' + when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })],
            ['Paid by', esc(grocer.name)],
            ['Amount', fmt(v.split.totalCents)],
            ['Split', 'Unequally · ' + v.members.length + ' people'],
          ].map(([k, val]) => `<div style="display:flex;justify-content:space-between;font:400 13.5px var(--ui);color:var(--ink-60)">
            <span>${k}</span><span style="color:var(--ink);font-weight:500${k === 'Amount' ? ';font-family:var(--mono)' : ''}">${val}</span>
          </div>`).join('')}
        </div>
      </div>

      <div class="meta">TAP A ROW TO COPY THE NUMBER</div>
      ${others.map((m) => `<button class="card" data-act="copy" data-id="${m.id}" style="border-radius:14px;padding:13px 14px;display:flex;align-items:center;gap:12px;width:100%">
        ${avatar(m, 30)}
        <span style="flex:1;font:500 15px var(--ui);text-align:left">${esc(m.name)}</span>
        <span style="font:600 17px var(--mono);font-variant-numeric:tabular-nums">${fmt(v.split.shares[m.id].cents)}</span>
        <span style="font:500 11px var(--mono);color:var(--ink-40)">COPY</span>
      </button>`).join('')}

      <button class="btn btn-outline" data-act="copy-all" style="margin-top:4px">Copy all ${others.length}</button>
    </div>

    <div class="grow"></div>
    <div class="sticky-foot">
      <button class="btn btn-primary" data-act="go" data-id="home">Done — back to receipts</button>
    </div>
  </div>`;
}

function screenHistory() {
  const rs = S.data.receipts;
  const counts = {};
  for (const r of rs) counts[r.grocer_id] = (counts[r.grocer_id] || 0) + 1;
  const most = Math.max(1, ...Object.values(counts));
  const shoppers = S.data.members
    .filter((m) => counts[m.id])
    .sort((a, b) => counts[b.id] - counts[a.id]);

  return `<div class="screen">
    <div style="padding:max(44px,env(safe-area-inset-top)) var(--gutter) 12px;display:flex;align-items:center;gap:12px">
      <button class="back" data-act="go" data-id="house">&larr;</button>
      <div class="title">History</div>
    </div>
    <div style="padding:6px var(--gutter) 0;display:flex;flex-direction:column;gap:8px">
      ${rs.length === 0 ? '<div class="card" style="padding:24px;text-align:center"><div class="body">Nothing here yet.</div></div>' : ''}
      ${rs.map((r) => {
        const g = memberById(r.grocer_id);
        const when = new Date(r.created_at * 1000);
        return `<button class="card" data-act="open" data-id="${r.id}" style="padding:14px;display:flex;align-items:center;gap:12px;width:100%;text-align:left">
          ${g ? avatar(g, 34) : ''}
          <span style="flex:1;display:flex;flex-direction:column;gap:2px">
            <span style="font:500 15px var(--ui)">${esc(r.store)}</span>
            <span style="font:400 11px var(--mono);color:var(--ink-40)">${upper(when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }))} · ${r.itemCount} ITEMS</span>
          </span>
          <span style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <span style="font:600 16px var(--mono);font-variant-numeric:tabular-nums">${fmt(r.totalCents)}</span>
            <span style="font:500 10px var(--mono);color:var(--ink-40)">${fmt(r.evenShareCents)} EA</span>
          </span>
        </button>`;
      }).join('')}
    </div>
    ${shoppers.length ? `<div style="padding:22px var(--gutter) 0">
      <div class="card" style="border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:12px">
        <div class="meta">WHO SHOPS MOST</div>
        ${shoppers.map((m) => `<div style="display:flex;align-items:center;gap:11px">
          <div style="width:56px;font:500 13px var(--ui)">${esc(m.name)}</div>
          <div style="flex:1;height:9px;border-radius:999px;background:var(--paper);overflow:hidden">
            <div style="height:9px;border-radius:999px;background:${esc(m.avatar_color)};width:${Math.round((counts[m.id] / most) * 100)}%"></div>
          </div>
          <div style="font:500 11px var(--mono);color:var(--ink-40);width:28px;text-align:right">${counts[m.id]}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}
    <div class="grow"></div>
  </div>`;
}

const PALETTE = ['#E8552D', '#3B7A57', '#5C574F', '#D9A400', '#8A6A4B', '#7A8B99', '#B0473F', '#4F6B8A', '#C2577A']; // last: pink (owner request)

function screenHouse() {
  const h = S.data.household;
  return `<div class="screen">
    <div style="padding:max(44px,env(safe-area-inset-top)) var(--gutter) 12px;display:flex;align-items:center;gap:12px">
      <div class="title" style="flex:1">${esc(h.name)}</div>
      <button class="pill" data-act="go" data-id="history">History</button>
    </div>
    <div style="padding:6px var(--gutter) 0;display:flex;flex-direction:column;gap:14px">
      <div class="card" style="border-radius:16px;overflow:hidden">
        ${S.data.members.map((m) => `<div style="border-bottom:1px solid var(--line-soft)">
          <div style="display:flex;align-items:center;gap:12px;min-height:58px;padding:0 15px">
            <button data-act="palette" data-id="${m.id}">${avatar(m, 32)}</button>
            <div style="flex:1;display:flex;flex-direction:column;gap:1px">
              <div style="font:500 15px var(--ui)">${esc(m.name)}</div>
              <div style="font:400 11px var(--mono);color:var(--ink-40)">${esc(m.telegram_handle || '')}</div>
            </div>
            <div style="font:500 11px var(--mono);color:var(--ink-40)">${m.id === meId() ? 'YOU' : ''}</div>
            <button class="pill" data-act="palette" data-id="${m.id}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--paper)">
              <span style="width:12px;height:12px;border-radius:999px;background:${esc(m.avatar_color)}"></span>
              <span style="font:500 9.5px var(--mono);letter-spacing:.06em;color:var(--ink-60)">COLOR</span>
            </button>
          </div>
          ${S.colorFor === m.id ? `<div style="display:flex;gap:8px;padding:0 15px 14px;flex-wrap:wrap;animation:gsIn .2s ease both">
            ${PALETTE.map((hex) => `<button data-act="set-color" data-id="${m.id}" data-hex="${hex}" style="width:28px;height:28px;border-radius:999px;background:${hex};box-shadow:0 0 0 2px var(--card),0 0 0 3.5px ${m.avatar_color === hex ? 'var(--ink)' : 'transparent'}"></button>`).join('')}
          </div>` : ''}
        </div>`).join('')}
        <div style="display:flex;align-items:center;gap:12px;min-height:56px;padding:0 15px">
          <div class="avatar" style="width:32px;height:32px;background:var(--paper);color:var(--ink-60);font-size:18px;font-weight:400">+</div>
          <div style="font:500 15px var(--ui);color:var(--ink-60)">Add them to the Telegram group</div>
        </div>
      </div>

      <div class="card" style="border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="flex:1;display:flex;flex-direction:column;gap:2px">
            <div style="font:500 15px var(--ui)">Poll window</div>
            <div style="font:400 12px var(--ui);color:var(--ink-60)">How long people get to opt out</div>
          </div>
          <button class="pill" data-act="poll-window" style="background:var(--paper);font:500 12px var(--mono)">${h.poll_window_hours}H</button>
        </div>
      </div>

      <div style="font:400 11.5px/1.5 var(--mono);color:var(--ink-40);text-align:center;padding-bottom:16px">
        GROSPLIT 0.1 · ${S.data.household.telegram_chat_id ? 'TELEGRAM BOT CONNECTED' : 'BOT NOT IN A GROUP YET'}
      </div>
    </div>
    <div class="grow"></div>
    ${tabbar('house')}
  </div>`;
}

// ── overlays ───────────────────────────────────────────────────────────────

function newSheet() {
  if (!S.newSheet) return '';
  const ms = S.data.members;
  const g = S.grocerDraft || meId();
  const now = new Date();
  return `<div class="scrim" data-act="close-new">
    <div style="width:100%;max-width:520px;margin:0 auto" data-stop>
      <div class="sheet-teeth"></div>
      <div class="sheet paper" style="animation:gsUp .34s var(--ease) both">
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding-bottom:13px;border-bottom:1px dashed var(--dot)">
          <div style="font:700 14px var(--mono);letter-spacing:.18em">NEW RECEIPT</div>
          <div style="font:400 10.5px var(--mono);letter-spacing:.08em;color:var(--ink-40)">${upper(now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))} · ${now.toTimeString().slice(0, 5)}</div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
          <div style="font:500 10.5px var(--mono);letter-spacing:.08em;color:var(--ink-40)">WHERE DID YOU SHOP?</div>
          <input class="field" id="store-draft" placeholder="Store name" autocomplete="off" style="height:52px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px">
            ${["Trader Joe's", 'Whole Foods', 'Safeway', 'Costco', 'Kroger', 'Target']
              .map((n) => `<button class="pill" data-act="pick-store" data-name="${esc(n)}" style="background:var(--paper)">${esc(n)}</button>`).join('')}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;padding-top:13px;margin-top:16px;border-top:1px dashed var(--dot)">
          <div style="font:500 10.5px var(--mono);letter-spacing:.08em;color:var(--ink-40)">WHO PAID?</div>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            ${ms.map((m) => `<button class="pill ${g === m.id ? 'on' : ''}" data-act="pick-grocer" data-id="${m.id}" style="display:flex;align-items:center;gap:7px;padding:5px 11px 5px 5px;${g === m.id ? '' : 'background:var(--paper)'}">
              ${avatar(m, 22)}<span style="font:500 12.5px var(--ui)">${m.id === meId() ? 'You' : esc(m.name)}</span>
            </button>`).join('')}
          </div>
        </div>

        <div class="leader" style="padding-top:14px;margin-top:16px;border-top:1px dotted var(--line);color:var(--ink-25)">
          <span>ITEMS</span><span class="leader-fill"></span><span>PENDING SCAN</span>
        </div>

        <button class="btn btn-primary" id="start-btn" data-act="start-receipt" style="margin-top:16px" disabled>Name the shop first</button>
      </div>
    </div>
  </div>`;
}

function payerSheet() {
  if (!S.payerSheet || !S.view) return '';
  const v = S.view;
  return `<div class="scrim" data-act="close-payer">
    <div class="sheet" data-stop>
      <div class="grab"></div>
      <div class="title">Who paid?</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:14px">
        ${v.members.map((m) => `<button class="pill ${v.receipt.grocer_id === m.id ? 'on' : ''}" data-act="pick-payer" data-id="${m.id}" style="display:flex;align-items:center;gap:7px;padding:5px 11px 5px 5px;${v.receipt.grocer_id === m.id ? '' : 'background:var(--paper)'}">
          ${avatar(m, 22)}<span style="font:500 12.5px var(--ui)">${m.id === meId() ? 'You' : esc(m.name)}</span>
        </button>`).join('')}
      </div>
      <div style="font:400 12px/1.45 var(--ui);color:var(--ink-60);margin-top:12px">The payer is who gets paid back, and the only one who can lock the split.</div>
    </div>
  </div>`;
}

function editSheet() {
  if (!S.editId || !S.view) return '';
  const it = S.view.items.find((i) => i.id === S.editId);
  if (!it) return '';
  const each = Math.round(it.price_cents / S.view.members.length);
  return `<div class="scrim" data-act="cancel-edit" style="background:rgba(28,26,23,.34)">
    <div class="sheet" data-stop>
      <div class="grab"></div>
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div class="title">Edit item</div>
        <div style="font:400 11px var(--mono);color:var(--ink-40)">${it.item_code ? '#' + esc(it.item_code) + ' · ' : ''}${it.ai_guess ? "AI WASN'T SURE" : 'FROM RECEIPT'}</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:7px;margin-top:15px">
        <div class="label">Name</div>
        <input class="field" id="edit-name" value="${esc(it.name)}" placeholder="What is it?" autocomplete="off">
        ${it.ai_guess ? `<button data-act="use-guess" style="align-self:flex-start;margin-top:2px;padding:8px 13px;border-radius:999px;background:var(--amber-soft);border:1px solid var(--amber-border);font:500 12.5px var(--ui);color:var(--amber-text-deep)">Use AI guess: ${esc(it.ai_guess)}</button>` : ''}
      </div>

      <div style="display:flex;flex-direction:column;gap:7px;margin-top:15px">
        <div class="label">Price</div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="field" style="flex:1;display:flex;align-items:center;gap:6px">
            <span style="font:500 15px var(--mono);color:var(--ink-40)">${cur()}</span>
            <input id="edit-price" inputmode="decimal" value="${(it.price_cents / 100).toFixed(2)}" style="flex:1;border:none;background:transparent;outline:none;font:500 19px var(--mono);font-variant-numeric:tabular-nums;width:100%">
          </div>
          <button data-act="step" data-by="-10" style="width:50px;height:50px;border-radius:12px;background:var(--card);border:1px solid var(--line);font-size:22px">−</button>
          <button data-act="step" data-by="10" style="width:50px;height:50px;border-radius:12px;background:var(--card);border:1px solid var(--line);font-size:22px">+</button>
        </div>
      </div>

      ${S.confirmDelete ? `<div style="margin-top:15px;padding:15px;border-radius:14px;background:var(--accent-soft);border:1px solid var(--danger-border);display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="font:600 15px var(--ui);color:var(--accent-deep)">Remove ${esc(it.name)}?</div>
          <div style="font:400 12.5px/1.45 var(--ui);color:#A0543A;text-wrap:pretty">It comes off the receipt and everyone's share drops by ${mono(each)}.</div>
        </div>
        <div style="display:flex;gap:10px">
          <button data-act="cancel-delete" style="flex:1;height:46px;border-radius:12px;background:var(--card);border:1px solid var(--danger-border);font:600 15px var(--ui);color:var(--ink-60)">Keep it</button>
          <button data-act="delete-item" style="flex:1;height:46px;border-radius:12px;background:var(--danger);color:#fff;font:600 15px var(--ui)">Remove</button>
        </div>
      </div>` : `<div style="display:flex;gap:10px;margin-top:15px">
        <button data-act="ask-delete" style="width:52px;height:50px;border-radius:13px;border:1px solid var(--danger-border);display:flex;align-items:center;justify-content:center">
          <svg width="17" height="19" viewBox="0 0 17 19" fill="none" aria-hidden="true"><path d="M2.5 5h12M6.5 2.5h4M4 5l.9 11.2a1 1 0 001 .8h5.2a1 1 0 001-.8L14 5M7 8.5v5.5M10 8.5v5.5" stroke="#B03A1B" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
        <button class="btn btn-primary" data-act="save-edit" style="flex:1;height:50px;border-radius:13px">Save</button>
      </div>`}
    </div>
  </div>`;
}

// ── render ─────────────────────────────────────────────────────────────────

const SCREENS = {
  onboarding: screenOnboarding, home: screenHome, scan: screenScan,
  review: screenReview, manual: screenManual, poll: screenPoll,
  live: screenLive, confirm: screenConfirm, export: screenExport,
  history: screenHistory, house: screenHouse,
};

function render() {
  if (!S.data) {
    app.innerHTML = '<div class="screen" style="align-items:center;justify-content:center"><div class="meta">LOADING</div></div>';
    return;
  }
  const needsView = ['scan', 'review', 'manual', 'poll', 'live', 'confirm', 'export'];
  if (needsView.includes(S.screen) && !S.view) S.screen = 'home';

  const body = (SCREENS[S.screen] || screenHome)();
  const toastHtml = S.toast
    ? `<div class="toast"><span class="check">✓</span><span style="flex:1">${esc(S.toast)}</span></div>`
    : '';
  app.innerHTML = body + newSheet() + payerSheet() + editSheet() + toastHtml;
  animateCounts();

  const storeInput = document.getElementById('store-draft');
  if (storeInput) {
    storeInput.focus();
    syncStartButton();
  }
}

function syncStartButton() {
  const input = document.getElementById('store-draft');
  const btn = document.getElementById('start-btn');
  if (!input || !btn) return;
  const named = input.value.trim().length > 0;
  btn.disabled = !named;
  btn.textContent = named ? 'Line up the receipt →' : 'Name the shop first';
}

// ── events ─────────────────────────────────────────────────────────────────

document.addEventListener('input', (e) => {
  if (e.target.id === 'store-draft') syncStartButton();
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act="shoot"]');
  if (!el || !el.files || !el.files[0]) return;
  const file = el.files[0];
  S.scanning = true;
  S.scanError = null;
  render();
  try {
    S.view = await api('POST', '/api/receipt/' + S.view.receipt.id + '/scan', undefined, file);
    S.scanning = false;
    await refreshState();
    go('review');
    toast('Receipt read — check the lines');
  } catch (err) {
    S.scanning = false;
    S.scanError = err.message;
    render();
  }
});

document.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-stop]');
  const el = e.target.closest('[data-act]');
  if (!el) {
    // Tapping the scrim itself cancels.
    if (!stop && e.target.classList.contains('scrim')) {
      S.newSheet = false; S.payerSheet = false; S.editId = null; S.confirmDelete = false; render();
    }
    return;
  }
  const a = el.getAttribute('data-act');
  const id = Number(el.getAttribute('data-id'));

  const sendPoll = () => handlers.__sendPollBody();
  const handlers = {
    go: () => {
      const target = el.getAttribute('data-id');
      if (target === 'home' || target === 'house' || target === 'history') { S.view = null; S.editId = null; }
      go(target);
    },

    flow: () => {
      const target = el.getAttribute('data-id');
      if (!flowReachable(target)) return toast('Finish the split first');
      go(target);
    },

    open: () => act(async () => {
      await loadReceipt(id);
      const r = S.view.receipt;
      go(r.status === 'confirmed' ? 'export' : r.status === 'polling' || r.status === 'posting' ? 'live' : S.view.pollCount > 0 ? 'confirm' : 'review');
    }),

    'new-sheet': () => { S.newSheet = true; S.grocerDraft = meId(); render(); },
    'close-new': () => { if (!stop) { S.newSheet = false; render(); } },
    'pick-store': () => {
      const input = document.getElementById('store-draft');
      if (input) { input.value = el.getAttribute('data-name'); syncStartButton(); }
    },
    'pick-grocer': () => { S.grocerDraft = id; render(); },
    'start-receipt': () => act(async () => {
      const input = document.getElementById('store-draft');
      const store = input ? input.value.trim() : '';
      if (!store) return;
      S.view = await api('POST', '/api/receipt', { store, grocerId: S.grocerDraft || meId() });
      S.selected = [];
      S.newSheet = false;
      await refreshState();
      go('scan');
    }),

    edit: () => {
      S.editId = id; S.confirmDelete = false;
      const it = S.view.items.find((i) => i.id === id);
      S.editSeen = it ? { name: it.name, price: it.price_cents } : null; // what the sheet opened with
      render();
    },
    'cancel-edit': () => { if (!stop) { S.editId = null; S.confirmDelete = false; render(); } },
    'use-guess': () => {
      const it = S.view.items.find((i) => i.id === S.editId);
      const input = document.getElementById('edit-name');
      if (it && input) input.value = it.ai_guess;
    },
    step: () => {
      const input = document.getElementById('edit-price');
      if (!input) return;
      const cents = Math.round((parseFloat(input.value) || 0) * 100) + Number(el.getAttribute('data-by'));
      input.value = (cents / 100).toFixed(2);
    },
    'save-edit': () => act(async () => {
      const name = (document.getElementById('edit-name').value || '').trim() || 'Untitled item';
      const price = parseFloat(document.getElementById('edit-price').value);
      await freshen();
      const cur = S.view.items.find((i) => i.id === S.editId);
      if (!cur) { S.editId = null; return toast('That line was removed by someone else.'); }
      const seen = S.editSeen;
      if (seen && (cur.name !== seen.name || cur.price_cents !== seen.price)) {
        S.editSeen = { name: cur.name, price: cur.price_cents }; // sheet re-renders with the fresh values
        return toast('Someone else just changed this line. Check it and save again.');
      }
      const items = S.view.items.map((i) =>
        i.id === S.editId
          ? { id: i.id, itemCode: i.item_code, name, priceCents: Math.round((isNaN(price) ? 0 : price) * 100), quantity: i.quantity, aiFlagged: false, aiGuess: null }
          : toPayload(i));
      S.view = await putItems(items);
      S.editId = null;
      await refreshState();
      toast('Item updated');
    }),
    'ask-delete': () => { S.confirmDelete = true; render(); },
    'cancel-delete': () => { S.confirmDelete = false; render(); },
    'delete-item': () => act(async () => {
      await freshen();
      if (!S.view.items.some((i) => i.id === S.editId)) {
        S.editId = null; S.confirmDelete = false;
        return toast('Already removed.');
      }
      const items = S.view.items.filter((i) => i.id !== S.editId).map(toPayload);
      S.view = await putItems(items);
      S.editId = null;
      S.confirmDelete = false;
      await refreshState();
      toast('Item removed');
    }),
    'fix-all': () => act(async () => {
      await freshen();
      const items = S.view.items.map((i) =>
        i.ai_guess ? { ...toPayload(i), name: i.ai_guess, aiFlagged: false, aiGuess: null } : { ...toPayload(i), aiFlagged: false });
      S.view = await putItems(items);
      toast('Names fixed');
    }),

    'add-item': () => act(async () => {
      const name = (document.getElementById('draft-name').value || '').trim();
      const price = parseFloat(document.getElementById('draft-price').value);
      if (!name) return toast('Give it a name');
      if (isNaN(price)) return toast('Give it a price');
      await freshen();
      const items = S.view.items.map(toPayload).concat([{ name, priceCents: Math.round(price * 100) }]);
      S.view = await putItems(items);
      await refreshState();
      go('review');
      toast(name + ' added');
    }),

    'toggle-tax': () => act(async () => {
      S.view = await api('PATCH', '/api/receipt/' + S.view.receipt.id, { taxEnabled: !S.view.receipt.tax_enabled });
      await refreshState();
    }),
    'tax-mode': () => act(async () => {
      S.view = await api('PATCH', '/api/receipt/' + S.view.receipt.id, { taxMode: el.getAttribute('data-id') });
      await refreshState();
    }),
    'edit-tax': () => act(async () => {
      const current = (S.view.receipt.tax_cents / 100).toFixed(2);
      const next = window.prompt('Tax as printed on the receipt', current);
      if (next === null) return;
      const cents = Math.round(parseFloat(next) * 100);
      if (isNaN(cents)) return toast("That's not a number");
      S.view = await api('PATCH', '/api/receipt/' + S.view.receipt.id, { taxCents: cents });
      await refreshState();
    }),

    pick: () => {
      const has = S.selected.includes(id);
      S.selected = has ? S.selected.filter((x) => x !== id) : S.selected.concat([id]);
      render();
    },
    'select-all': () => {
      S.selected = S.selected.length ? [] : S.view.items.map((i) => i.id);
      render();
    },
    'send-poll': () => {
      if (S.view.pollCount > 0) { S.confirmReplace = true; render(); return; }
      sendPoll();
    },
    'keep-votes': () => { S.confirmReplace = false; go('confirm'); },
    'replace-poll': () => { S.confirmReplace = false; sendPoll(); },
    '__sendPollBody': () => act(async () => {
      const rid = S.view.receipt.id;
      try {
        S.view = await api('POST', '/api/receipt/' + rid + '/poll', { itemIds: S.selected });
      } catch (e) {
        // 409: someone else is posting; it may be live a moment later. 400 (cap): stay put.
        if (e.status === 409) {
          const keep = S.selected.slice(); // loadReceipt resets picks to the server's; back in review, restore ours
          await loadReceipt(rid);
          if (S.view.receipt.status === 'review') S.selected = keep.filter((x) => S.view.items.some((i) => i.id === x));
          await refreshState(); go(S.view.receipt.status === 'review' ? 'poll' : 'live');
        }
        throw e;
      }
      await refreshState();
      go('live');
      toast('Poll posted');
    }),
    'close-poll': () => act(async () => {
      S.view = await api('POST', '/api/receipt/' + S.view.receipt.id + '/close-poll');
      stopLive();
      await refreshState();
      go('confirm');
    }),
    lock: () => act(async () => {
      S.view = await api('POST', '/api/receipt/' + S.view.receipt.id + '/confirm');
      await refreshState();
      go('export');
      toast('Split locked — nobody can change it now');
    }),

    copy: () => {
      const m = memberById(id);
      const amount = fmt(S.view.split.shares[id].cents);
      copyText(amount);
      toast('Copied ' + amount + ' — ' + m.name);
    },
    'copy-all': () => {
      const lines = S.view.members
        .filter((m) => m.id !== S.view.receipt.grocer_id)
        .map((m) => m.name + '  ' + fmt(S.view.split.shares[m.id].cents));
      copyText(lines.join('\n'));
      toast('All ' + lines.length + ' amounts copied');
    },

    'payer-sheet': () => { S.payerSheet = true; render(); },
    'close-payer': () => { if (!stop) { S.payerSheet = false; render(); } },
    'pick-payer': () => act(async () => {
      S.view = await api('PATCH', '/api/receipt/' + S.view.receipt.id, { grocerId: id });
      S.payerSheet = false;
      await refreshState();
      toast('Payer changed');
    }),
    'ask-del-receipt': () => { S.confirmDeleteReceipt = true; render(); },
    'cancel-del-receipt': () => { S.confirmDeleteReceipt = false; render(); },
    'del-receipt': () => act(async () => {
      await api('DELETE', '/api/receipt/' + S.view.receipt.id);
      S.view = null;
      S.confirmDeleteReceipt = false;
      await refreshState();
      go('home');
      toast('Receipt deleted');
    }),

    reload: () => location.reload(),

    palette: () => { S.colorFor = S.colorFor === id ? null : id; render(); },
    'set-color': () => act(async () => {
      S.data.members = await api('PATCH', '/api/member/' + id, { avatarColor: el.getAttribute('data-hex') });
      S.colorFor = null;
      if (S.view) await loadReceipt(S.view.receipt.id);
    }),
    'poll-window': () => act(async () => {
      const next = window.prompt('Hours people get to opt out', String(S.data.household.poll_window_hours));
      if (next === null) return;
      S.data.household = await api('PATCH', '/api/household', { pollWindowHours: Number(next) });
    }),
  };

  const fn = handlers[a];
  if (fn) fn();
});

// Existing items carry their id so the server updates them in place (keeps poll opt-outs).
// New items (add-item) have no id; items left out of the array are deleted.
const toPayload = (i) => ({
  id: i.id, itemCode: i.item_code, name: i.name, priceCents: i.price_cents, quantity: i.quantity,
  aiFlagged: !!i.ai_flagged, aiGuess: i.ai_guess,
});

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* nothing more to try */ }
  document.body.removeChild(ta);
}

// ── boot ───────────────────────────────────────────────────────────────────

// Deep link: #screen or #screen/receiptId. Lets the bot link straight to a
// split, and makes every screen individually openable.
async function fromHash() {
  const [screen, rid] = location.hash.replace(/^#\/?/, '').split('/');
  if (!screen || !SCREENS[screen]) return false;
  if (rid) {
    try { await loadReceipt(Number(rid)); } catch { return false; }
  }
  S.screen = screen;
  return true;
}

(async function boot() {
  try {
    await refreshState();
    S.screen = S.data.receipts.length ? 'home' : 'onboarding';
    await fromHash();
    render();
  } catch (e) {
    // Signed in fine, but the server says this person isn't in the household's group.
    // Warm and specific: say what to do, and give one button (the only accent here).
    if (e.code === 'not_in_group' || e.code === 'no_household') {
      const none = e.code === 'no_household';
      app.innerHTML =
        '<div class="screen" style="justify-content:center;padding:40px 28px;gap:10px">' +
        '<div style="width:48px;height:48px;border-radius:15px;background:var(--ink);display:flex;align-items:center;justify-content:center;color:var(--card);font:700 24px var(--ui);margin-bottom:14px">G</div>' +
        '<div class="display" style="text-wrap:pretty">' + (none ? 'No group linked yet' : 'You’re not in the group yet') + '</div>' +
        '<div class="body">' + (none
          ? 'GroSplit needs your household’s Telegram group. Add the GroSplit bot to that group, then open the app from there.'
          : 'GroSplit opens for the people in the household’s Telegram group. Ask a housemate to add you to it, then open this again.') + '</div>' +
        '<div class="meta" style="letter-spacing:normal;margin-top:4px">' + (none ? 'GROUP → ADD MEMBER → THE GROSPLIT BOT' : 'ONCE YOU’RE IN, THIS OPENS STRAIGHT AWAY') + '</div>' +
        '<button class="btn btn-primary" data-act="reload" style="margin-top:22px">I’m in — try again</button>' +
        '</div>';
      return;
    }
    // Say which of the three things went wrong, in words that suggest a fix.
    // "initData missing" is true but useless to whoever is holding the phone.
    let title = "Can't reach GroSplit";
    let detail = e.message;
    let hint = '';

    if (!TG) {
      title = 'Open this from Telegram';
      detail = 'This is a Telegram Mini App, so it needs to be opened inside Telegram.';
      hint = 'Tap the bot’s menu button, or the pinned button in your group.';
    } else if (!TG.initData) {
      title = 'Telegram didn’t sign you in';
      detail = 'The app opened, but Telegram passed no sign-in data — which happens when it is opened as a plain link rather than as a Mini App.';
      hint = 'Open it from the bot’s menu button instead. If that works, the group link needs "Configure Mini App" set in BotFather.';
    } else if (/initData/i.test(e.message)) {
      detail = 'Telegram signed you in, but the server rejected it.';
      hint = 'Usually the server is running with a different bot token than the one that opened this app.';
    }

    app.innerHTML =
      '<div class="screen" style="align-items:center;justify-content:center;padding:40px;text-align:center;gap:12px">' +
      '<div class="title">' + esc(title) + '</div>' +
      '<div class="body">' + esc(detail) + '</div>' +
      (hint ? '<div class="body" style="color:var(--ink-40)">' + esc(hint) + '</div>' : '') +
      '<div class="meta" style="margin-top:14px;letter-spacing:normal">' +
      'tg:' + (TG ? 'yes' : 'no') +
      ' · initData:' + (TG && TG.initData ? TG.initData.length + 'ch' : 'none') +
      ' · v' + (TG && TG.version ? TG.version : '?') +
      '</div></div>';
  }
})();
