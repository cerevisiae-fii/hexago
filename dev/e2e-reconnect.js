#!/usr/bin/env node
'use strict';
/**
 * Online resilience E2E (PeerJS cloud, no own server):
 *   - guest reconnect after a dropped host connection
 *   - host peer recovery after the signalling/peer drops
 *   - host page reload -> host room resumes, guest auto-rejoins
 *   - guest page reload -> guest auto-rejoins and keeps the seat
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright node dev/e2e-reconnect.js
 *
 * Needs internet access to the public PeerJS cloud; exits 0 with SKIP if the
 * first room cannot be created.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright');
  for (const name of tries) { try { return require(name); } catch (e) { /* next */ } }
  console.error('dev/e2e-reconnect.js needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..');
const PORT = 8976;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const f = path.join(REPO, u === '/' ? 'index.html' : u);
      if (!f.startsWith(REPO)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (e, d) => {
        if (e) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(d);
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
async function waitFor(fn, timeout, interval) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 20000)) {
    try { if (await fn()) return true; } catch (e) { /* retry */ }
    await sleep(interval || 250);
  }
  return false;
}
async function loadPage(browser, url) {
  const p = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await p.goto(url, { waitUntil: 'load', timeout: 45000 });
  await p.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 15000 });
  await p.evaluate(() => { const m = document.getElementById('setModal'); if (m) m.classList.remove('hidden'); });
  return p;
}
const stones = p => p.evaluate(() => window.__hexagoDebug.state().board.filter(Boolean).length);
const net = p => p.evaluate(() => window.__hexagoDebug.net());
const dbgState = p => p.evaluate(() => window.__hexagoDebug.state());

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true });
  const url = `http://127.0.0.1:${PORT}/index.html`;
  const room = 'REC' + (Date.now() % 100000);
  const errors = [];
  const host = await loadPage(browser, url);
  const guest = await loadPage(browser, url);
  for (const [name, p] of [['host', host], ['guest', guest]]) {
    p.on('pageerror', e => errors.push(name + ': ' + String(e && e.message || e)));
    p.on('console', m => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  }

  // ---- setup room, seats, game, one move ----
  await host.evaluate(r => {
    document.querySelector('#modeBtns [data-v="online"]').click();
    document.getElementById('hostNickname').value = 'host';
    document.getElementById('hostRoomId').value = r;
    document.getElementById('btnCreate').click();
  }, room);
  const hostCreated = await waitFor(() => host.evaluate(() => {
    const n = window.__hexagoDebug.net();
    return n.isHost && n.peerOpen && document.getElementById('roomSt').textContent.includes('ルームID');
  }), 25000);
  check('host creates room', hostCreated, 'room=' + room);
  if (!hostCreated) { console.log('SKIP: PeerJS cloud unavailable'); await browser.close(); server.close(); process.exit(0); }

  await guest.evaluate(r => {
    document.querySelector('#modeBtns [data-v="online"]').click();
    document.querySelector('#boardViewToggle [data-board-view="participant"]').click();
    document.getElementById('roomIn').value = r;
    document.getElementById('nickIn').value = 'guest';
    document.getElementById('btnJoin').click();
  }, room);
  const hostSawGuest = await waitFor(() => host.evaluate(() =>
    [...document.querySelectorAll('#roomPool span')].some(el => el.textContent.includes('guest'))), 25000);
  check('guest joins', hostSawGuest);

  const claims = await host.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatBtns > div')];
    const btn = [...rows[0].querySelectorAll('button')].find(b => b.textContent.includes('この席で参加'));
    if (btn) { btn.click(); return true; } return false;
  });
  await sleep(700);
  const guestClaim = await guest.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatBtns > div')];
    const btn = [...(rows[1] || rows[0]).querySelectorAll('button')].find(b => b.textContent.includes('この席で参加'));
    if (btn) { btn.click(); return true; } return false;
  });
  await sleep(1000);
  check('both seats claimed', claims && guestClaim);

  await host.evaluate(() => {
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    document.getElementById('btnNew').click();
  });
  await sleep(1200);
  const hostMove = await host.evaluate(() => {
    const d = window.__hexagoDebug;
    return d.state().turn === 1 ? d.playMove(30) : false;
  });
  await waitFor(async () => (await stones(guest)) >= 1, 8000);
  check('initial move synced', hostMove && (await stones(guest)) >= 1, 'guest stones=' + await stones(guest));

  // ---- A. guest connection drop (host stays alive) ----
  await guest.evaluate(() => window.__hexagoDebug.netDropGuestConn());
  const guestBack = await waitFor(async () => {
    const n = await net(guest);
    return n.hostConnOpen && n.myRole === 2;
  }, 25000);
  const guestState = await dbgState(guest);
  check('guest auto-reconnects after a dropped connection', guestBack && guestState.board.filter(Boolean).length >= 1, JSON.stringify({ role: guestState.turn, stones: guestState.board.filter(Boolean).length }));

  // ---- B. host peer drop (guest must wait and then rejoin) ----
  await host.evaluate(() => window.__hexagoDebug.netDropHostPeer());
  const hostBack = await waitFor(async () => {
    const n = await net(host);
    return n.isHost && n.peerOpen && n.roomCode === room;
  }, 30000);
  const guestRejoined = await waitFor(async () => {
    const n = await net(guest);
    return n.hostConnOpen && n.myRole === 2;
  }, 30000);
  check('host recovers its peer after a drop', hostBack, JSON.stringify(await net(host)));
  check('guest rejoins after host recovery', guestRejoined, JSON.stringify(await net(guest)));

  const hostTurn = await dbgState(host);
  const moved = hostTurn.turn === 1 ? await host.evaluate(() => { const d = window.__hexagoDebug; for (let i = 0; i < d.state().board.length; i++) if (!d.state().board[i] && d.sim(i)) return d.playMove(i); return false; }) : false;
  const synced = await waitFor(async () => (await stones(guest)) >= (await stones(host)), 12000);
  check('state syncs after recovery', moved && synced, 'host=' + await stones(host) + ' guest=' + await stones(guest));

  // ---- C. host page reload (session resume + guest auto-rejoin) ----
  const stonesBeforeReload = await stones(host);
  await host.reload({ waitUntil: 'load' });
  await host.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 20000 });
  const hostResumed = await waitFor(async () => {
    const n = await net(host);
    return n.isHost && n.peerOpen && n.roomCode === room;
  }, 40000);
  const guestAfterHostReload = await waitFor(async () => {
    const n = await net(guest);
    return n.hostConnOpen && n.myRole === 2;
  }, 40000);
  const restoredStones = await stones(host);
  check('host reload resumes the same room', hostResumed, JSON.stringify(await net(host)));
  check('host reload keeps the game state', restoredStones >= stonesBeforeReload, 'stones=' + restoredStones);
  check('guest auto-rejoins after host reload', guestAfterHostReload, JSON.stringify(await net(guest)));

  // ---- D. guest page reload (auto-rejoin + seat restored) ----
  await guest.reload({ waitUntil: 'load' });
  await guest.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 20000 });
  const guestResumed = await waitFor(async () => {
    const n = await net(guest);
    const st = await dbgState(guest);
    return n.hostConnOpen && n.myRole === 2 && st.seats[2] === 'human';
  }, 40000);
  check('guest reload auto-rejoins with the same seat', guestResumed, JSON.stringify(await net(guest)));

  const relevant = errors.filter(e => !/tailwindcss\.com should not be used|ERR_|Failed to load resource|WebSocket|net::/i.test(e));
  check('no page errors during reconnects', relevant.length === 0, relevant.slice(0, 3).join(' | ') || 'none');

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'RECONNECT E2E ALL PASS' : 'RECONNECT E2E FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
  console.log('----------------------------------------');
  await browser.close();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('RECONNECT E2E CRASHED:', e); process.exit(2); });
