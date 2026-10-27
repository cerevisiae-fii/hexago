#!/usr/bin/env node
'use strict';
/**
 * Optional online (PeerJS) E2E: host + participant, seat claiming, state sync,
 * and an AI seat moving on the host.
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright node dev/e2e-online.js
 *
 * Needs internet access to the public PeerJS cloud (the page already depends on it).
 * Exits 0 with a SKIP message if the two peers cannot connect (e.g. blocked network).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright');
  for (const name of tries) {
    try { return require(name); } catch (e) { /* next */ }
  }
  console.error('dev/e2e-online.js needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..');
const PORT = 8973;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(REPO, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(REPO)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true });
  const url = `http://127.0.0.1:${PORT}/index.html`;
  const room = 'HEX' + (Date.now() % 100000);
  const errors = [];

  const host = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const guest = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  for (const [name, p] of [['host', host], ['guest', guest]]) {
    p.on('pageerror', e => errors.push(name + ': ' + String(e && e.message || e)));
    p.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  }

  await host.goto(url, { waitUntil: 'load', timeout: 45000 });
  await guest.goto(url, { waitUntil: 'load', timeout: 45000 });
  for (const p of [host, guest]) {
    await p.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 15000 });
    await p.evaluate(() => { const m = document.getElementById('setModal'); if (m) m.classList.remove('hidden'); });
  }

  // host: online mode + create room
  await host.evaluate(r => {
    document.querySelector('#modeBtns [data-v="online"]').click();
    document.getElementById('hostNickname').value = 'host';
    document.getElementById('hostRoomId').value = r;
    document.getElementById('btnCreate').click();
  }, room);
  const hostReady = await host.waitForFunction(() => {
    const d = window.__hexagoDebug;
    const st = d && d.state();
    return st && st.mode === 'online' && document.getElementById('roomSt').textContent.includes('ルームID');
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  check('host created room via PeerJS', hostReady, 'room=' + room);
  if (!hostReady) {
    console.log('SKIP: PeerJS cloud did not connect (network blocked?)');
    await browser.close(); server.close(); process.exit(0);
  }

  // guest: online mode + join
  await guest.evaluate(r => {
    document.querySelector('#modeBtns [data-v="online"]').click();
    document.querySelector('#boardViewToggle [data-board-view="participant"]').click();
    document.getElementById('roomIn').value = r;
    document.getElementById('nickIn').value = 'guest';
    document.getElementById('btnJoin').click();
  }, room);
  const guestPooled = await guest.waitForFunction(() => {
    const st = document.getElementById('roomSt').textContent;
    return st.includes('ルームID') && document.querySelectorAll('#roomPool > *').length >= 1;
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  check('guest joined and received snapshot', guestPooled);
  const hostSawGuest = await host.waitForFunction(() => {
    return [...document.querySelectorAll('#roomPool span')].some(el => el.textContent.includes('guest'));
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('host sees guest in the room pool', hostSawGuest);

  // host claims seat 1, guest claims seat 2
  const hostSeat = await host.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatBtns > div')];
    const row = rows[0];
    const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.includes('この席で参加'));
    if (!btn) return false;
    btn.click(); return true;
  });
  await sleep(800);
  const guestSeat = await guest.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatBtns > div')];
    const row = rows[1] || rows[0];
    const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.includes('この席で参加'));
    if (!btn) return false;
    btn.click(); return true;
  });
  await sleep(1200);
  check('both players claimed a seat', hostSeat && guestSeat, 'host=' + hostSeat + ' guest=' + guestSeat);

  // host: 2 players, 9 board, weak AI, start a new game
  await host.evaluate(() => {
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    document.querySelector('#sizeBtns [data-v="9"]')?.click();
    document.querySelector('#aiLevelBtns [data-ai="weak"]')?.click();
    document.getElementById('btnNew').click();
  });
  await sleep(1000);
  const started = await guest.waitForFunction(() => {
    const st = window.__hexagoDebug.state();
    return st.phase === 'playing' && st.seats.length >= 2;
  }, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check('new game synchronized to guest', started);

  // host (player 1) plays the centre point, guest must see it
  const hostMove = await host.evaluate(() => {
    const d = window.__hexagoDebug;
    const st = d.state();
    if (st.turn !== 1) return { ok: false, reason: 'not host turn: ' + st.turn };
    return { ok: d.playMove(30), stones: d.state().board.filter(Boolean).length };
  });
  await sleep(1000);
  const guestSynced = await guest.waitForFunction(() => window.__hexagoDebug.state().board.filter(Boolean).length >= 1, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('host move synced to guest', hostMove.ok && guestSynced, JSON.stringify(hostMove));

  // turn 2 -> switch seat 2 to AI on the host; host AI plays and syncs
  const seat2AI = await host.evaluate(() => {
    const rows = [...document.querySelectorAll('#seatBtns > div')];
    const row = rows[1];
    const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.trim() === 'AI');
    if (!btn) return false;
    btn.click(); return true;
  });
  await sleep(300);
  const aiMoved = await host.waitForFunction(() => window.__hexagoDebug.state().board.filter(Boolean).length >= 2, null, { timeout: 20000 }).then(() => true).catch(() => false);
  const guestSawAI = await guest.waitForFunction(() => window.__hexagoDebug.state().board.filter(Boolean).length >= 2, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('AI seat moved on host', seat2AI && aiMoved);
  check('AI move synced to guest', guestSawAI);

  const relevant = errors.filter(e => !/tailwindcss\.com should not be used|ERR_|Failed to load resource|WebSocket/i.test(e));
  check('no page errors on host/guest', relevant.length === 0, relevant.slice(0, 2).join(' | ') || 'none');

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'ONLINE E2E ALL PASS' : 'ONLINE E2E FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
  console.log('----------------------------------------');
  await browser.close();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ONLINE E2E CRASHED:', e); process.exit(2); });
