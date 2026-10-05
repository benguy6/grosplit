'use strict';

// Screenshot every deep-linkable screen at phone size, for visual testing.
// DEV mode on a throwaway database — never touches ./grosplit.db.
//
//   node scripts/shots.js [outDir]        default outDir: .shots/
//   WIDTH=360 HEIGHT=780 node scripts/shots.js
//   CHROME=/path/to/chrome node scripts/shots.js
//
// ponytail: headless Chrome over raw DevTools, no Playwright. It can't click, so bottom
// sheets and toasts aren't captured; add Playwright as a devDependency if that matters.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP = path.join(os.tmpdir(), 'grosplit-shots-' + process.pid + '.db');
process.env.DATABASE_PATH = TMP;
delete process.env.TELEGRAM_BOT_TOKEN; // DEV mode
process.env.DEV = '1';

const { server, db } = require('../server.js');
const d = require('../db.js');
const seed = require('../seed.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '.shots'));
const W = Number(process.env.WIDTH || 390);
const H = Number(process.env.HEIGHT || 844);
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p));

// The seed has no live poll, so build one: 3 polled items, 3 of 5 voted, 2 opt-outs.
function seedLivePoll() {
  const house = d.firstHousehold(db);
  const ms = d.members(db, house.id);
  const r = d.createReceipt(db, { householdId: house.id, store: 'Whole Foods', grocerId: ms[0].id });
  const items = d.replaceItems(db, r.id, seed.ACTIVE_ITEMS);
  const polled = items.slice(5, 8);
  polled.forEach((it, i) =>
    db.prepare('INSERT INTO polled_item (receipt_id, item_id, option_index) VALUES (?, ?, ?)').run(r.id, it.id, i));
  const now = Math.floor(Date.now() / 1000);
  for (const m of ms.slice(1, 4)) {
    db.prepare('INSERT INTO poll_voter (receipt_id, member_id, voted_at) VALUES (?, ?, ?)').run(r.id, m.id, now);
  }
  db.prepare('INSERT INTO opt_out (receipt_id, item_id, member_id) VALUES (?, ?, ?)').run(r.id, polled[0].id, ms[1].id);
  db.prepare('INSERT INTO opt_out (receipt_id, item_id, member_id) VALUES (?, ?, ?)').run(r.id, polled[0].id, ms[3].id);
  db.prepare("UPDATE receipt SET status = 'polling', poll_closes_at = ?, tax_cents = 1139 WHERE id = ?")
    .run(now + 3 * 3600 + 52 * 60, r.id);
  return r.id;
}

async function main() {
  if (!CHROME) throw new Error('No Chrome/Edge found. Set CHROME=/path/to/browser');
  const liveId = seedLivePoll();
  // Seed order: receipt 1 is the active Trader Joe's review, 2–6 are confirmed history.
  const screens = [
    'onboarding', 'home', 'house', 'history',
    'scan/1', 'review/1', 'manual/1', 'poll/1', 'live/' + liveId, 'confirm/1', 'export/2',
  ];

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(OUT, { recursive: true });
  // Headless Chrome refuses windows under ~500px, so --window-size=390 silently
  // lays out wider and crops. Emulate the phone viewport over DevTools instead.
  // Own throwaway profile: never touches the user's real browser profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grosplit-chrome-'));
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', `--window-size=1000,${H}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      ch.stderr.on('data', (c) => {
        buf += c;
        const m = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(buf);
        if (m) resolve(m[1]);
      });
      ch.on('exit', () => reject(new Error('Chrome exited before DevTools came up')));
      setTimeout(() => reject(new Error('Chrome DevTools timeout')), 20000);
    });
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (m) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result); pending.delete(j.id); }
    });
    const cdp = (method, params) => new Promise((r) => {
      pending.set(++seq, r);
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    for (const s of screens) {
      const file = path.join(OUT, `${W}-${s.replace('/', '-')}.png`);
      fs.rmSync(file, { force: true });
      // Via about:blank so a hash-only change still reloads the app.
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${base}/#${s}` });
      await sleep(2500); // load + count-up animations
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const o = await cdp('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth > innerWidth' });
      console.log(file + (o.result.value ? '  OVERFLOW' : ''));
    }
    ws.close();
  } finally {
    ch.kill();
    await new Promise((r) => setTimeout(r, 500)); // let Chrome release the profile
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* EPERM on Windows: leave it */ }
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => {
    server.close();
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TMP + suffix); } catch { /* fine */ }
    }
  });
