#!/usr/bin/env node
'use strict';
/**
 * Dead-stone detection / human-review E2E.
 *  - an enclosed dead group is auto-detected
 *  - tapping a group toggles it (human correction)
 *  - recheck / clear / confirm buttons work
 *  - a group with two eyes is NOT auto-marked dead
 *  - final scoring is Chinese area scoring (territory + stones, no prisoners)
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright node dev/e2e-deadstone.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright');
  for (const name of tries) { try { return require(name); } catch (e) { /* next */ } }
  console.error('dev/e2e-deadstone.js needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}
const { chromium } = loadPlaywright();
const AI = require('./ai-engine.js');
const rules = require('../bench/lib/rules.js');

const REPO = path.resolve(__dirname, '..');
const PORT = 8980;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const geo = AI.geometry(9);
const P = geo.P;
const idxOf = (q, r) => P.findIndex(([a, b]) => a === q && b === r);

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

// white group at the centre + (1,0), surrounded by a black ring at distance 2:
// 5 inside liberties, no eyes -> dead once black fills them.
function buildDeadBoard() {
  const b = new Array(geo.n).fill(0);
  const w1 = idxOf(0, 0), w2 = idxOf(1, 0);
  b[w1] = 2; b[w2] = 2;
  for (let i = 0; i < P.length; i++) if (geo.dist(i, geo.center) === 2) b[i] = 1;
  return { board: b, group: [w1, w2] };
}

// random legal position that contains a group with >= 2 eyes
function buildLiveBoard() {
  const R = rules.createRules(9);
  for (let seed = 1; seed <= 40; seed++) {
    const st = R.newState(2);
    const rng = rules.makeRng(seed);
    for (let k = 0; k < 400 && st.board.filter(Boolean).length < 54; k++) {
      const moves = R.legalMoves(st);
      if (!moves.length) break;
      R.applyMove(st, moves[Math.floor(rng() * moves.length)]);
    }
    const seen = new Set();
    for (let i = 0; i < st.board.length; i++) {
      if (!st.board[i] || seen.has(i)) continue;
      const g = R.groupOf(st.board, i);
      g.forEach(x => seen.add(x));
      if (R.countEyes(st.board, g, st.board[i]) >= 2) return { board: st.board.slice(), group: g };
    }
  }
  throw new Error('could not generate a two-eye group');
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 15000 });
  await page.evaluate(() => {
    const m = document.getElementById('setModal'); if (m) m.classList.add('hidden');
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    window.__hexagoDebug.setAllHuman();
    window.__hexagoDebug.newGame(9);
  });
  await sleep(300);

  /* ---- dead group detection ---- */
  const dead = buildDeadBoard();
  await page.evaluate(b => { window.__hexagoDebug.setBoardForTest(b); }, dead.board);
  const deadInfo = await page.evaluate(() => window.__hexagoDebug.enterDeadPhase());
  const smartSet = new Set(deadInfo);
  check('enclosed group auto-detected as dead', dead.group.every(i => smartSet.has(i)), 'group=' + dead.group.join(',') + ' detected=' + deadInfo.length);
  const banner = await page.evaluate(() => ({
    counts: document.getElementById('deadCount').textContent,
    hasRecheck: !!document.getElementById('btnDeadRecheck'),
    hasClear: !!document.getElementById('btnDeadClear'),
  }));
  check('dead-stone banner shows count and review buttons', /自動判定/.test(banner.counts) && banner.hasRecheck && banner.hasClear, JSON.stringify(banner));

  /* ---- human correction: tap the group on the canvas ---- */
  const [wq, wr] = P[dead.group[0]];
  const pt = await page.evaluate(({ q, r }) => {
    const rc = document.getElementById('cv').getBoundingClientRect();
    const w = rc.width, pad = w * 0.07, cell = (w - pad * 2) / (2 * 4);
    return { x: rc.left + w / 2 + cell * (q + r / 2), y: rc.top + w / 2 + cell * r * 0.866 };
  }, { q: wq, r: wr });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(200);
  const afterTap = await page.evaluate(() => window.__hexagoDebug.deadInfo());
  check('tapping a group toggles it off (human correction)', !dead.group.some(i => afterTap.dead.includes(i)), 'dead=' + afterTap.dead.length);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(200);
  const afterTap2 = await page.evaluate(() => window.__hexagoDebug.deadInfo());
  check('tapping again restores the group', dead.group.every(i => afterTap2.dead.includes(i)), 'dead=' + afterTap2.dead.length);

  /* ---- recheck / clear buttons ---- */
  await page.click('#btnDeadClear');
  await page.waitForTimeout(120);
  const cleared = await page.evaluate(() => window.__hexagoDebug.deadInfo().dead.length);
  await page.click('#btnDeadRecheck');
  await page.waitForTimeout(120);
  const rechecked = await page.evaluate(() => window.__hexagoDebug.deadInfo().dead.length);
  check('clear / recheck buttons work', cleared === 0 && rechecked >= dead.group.length, 'clear=' + cleared + ' recheck=' + rechecked);

  /* ---- confirm: Chinese area scoring, dead stones removed ---- */
  await page.click('#btnDeadOk');
  await page.waitForTimeout(300);
  const finished = await page.evaluate(() => {
    const d = window.__hexagoDebug;
    return { over: d.state().over, scores: d.scoreInfo(), result: d.state().result };
  });
  const removed = await page.evaluate(b => {
    const d = window.__hexagoDebug;
    return window.__hexagoDebug.state().board.map((v, i) => (v === 0 && b[i] !== 0) ? 1 : 0).reduce((a, c) => a + c, 0);
  }, dead.board);
  check('finish removes the dead stones and ends the game', finished.over && removed >= dead.group.length, 'over=' + finished.over + ' removed=' + removed);
  const totalsOk = finished.scores && finished.scores.total.every((v, i) => v === finished.scores.territory[i] + finished.scores.stones[i]);
  check('score is area scoring (territory + stones, no prisoners)', totalsOk, JSON.stringify(finished.scores && { t: finished.scores.territory, s: finished.scores.stones, total: finished.scores.total }));

  /* ---- a two-eye group is not marked dead ---- */
  const live = buildLiveBoard();
  await page.evaluate(b => { window.__hexagoDebug.setBoardForTest(b); }, live.board);
  const liveDead = await page.evaluate(() => window.__hexagoDebug.enterDeadPhase());
  const liveSet = new Set(liveDead);
  check('two-eye group is never auto-marked dead', !live.group.some(i => liveSet.has(i)), 'liveStones=' + live.group.length + ' autoDead=' + liveDead.length);

  const relevant = errors.filter(e => !/tailwindcss\.com should not be used|ERR_|Failed to load resource/i.test(e));
  check('no page errors', relevant.length === 0, relevant.slice(0, 2).join(' | ') || 'none');

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'DEAD-STONE E2E ALL PASS' : 'DEAD-STONE E2E FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
  console.log('----------------------------------------');
  await browser.close();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('DEAD-STONE E2E CRASHED:', e); process.exit(2); });
