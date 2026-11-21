#!/usr/bin/env node
/* Live-deployment check: open the GitHub Pages build in headless Chrome,
 * confirm it serves the expected engine/pool version, run real worker-pool
 * AI moves on the live site, and save a screenshot.
 *
 * Usage: node dev/cdp/live-check.js [url]
 *   default url: https://sas-news.github.io/hexago/
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { Browser, sleep } = require('./driver');

async function main() {
  const url = process.argv[2] || 'https://sas-news.github.io/hexago/';
  const shotsDir = path.join(__dirname, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const shot = path.join(shotsDir, 'live-pages-check.png');
  let browser = null;
  const out = { url };
  try {
    browser = await Browser.launch({ timeoutMs: 60000 });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      timeoutMs: 60000,
    });
    await page.goto(url, { timeoutMs: 45000 });
    await page.waitForFunction('window.__hexagoDebug && typeof window.__hexagoDebug.state === "function"', {
      timeoutMs: 20000, label: 'window.__hexagoDebug',
    });
    await sleep(700); // async boot (worker pool etc.)

    out.boot = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      const r = cv.getBoundingClientRect();
      return {
        title: document.title,
        engineVersion: (self.HexagoAI && self.HexagoAI.version) || null,
        pageBudgetMs: window.__hexagoDebug.state().aiBudget,
        engine: window.__hexagoDebug.engine(),
        size: window.__hexagoDebug.state().size,
        players: window.__hexagoDebug.state().playerCount,
        scriptFiles: Array.from(document.scripts).map(s => (s.src || '').split('/').pop()).filter(Boolean),
        photoPresent: !!(self.HexagoPhotoTest || document.querySelector('#photoModal') || typeof takePhoto === 'function'),
        canvas: { cssW: Math.round(r.width), cssH: Math.round(r.height), pxW: cv.width, pxH: cv.height },
        jsErrors: (window.__hexagoErrors || []).slice(0, 3),
      };
    });

    // ---- start a quick local game: all-AI, one real pooled think at 600ms ----
    await page.evaluate(() => {
      window.__hexagoDebug.newGame(9);
      window.__hexagoDebug.setAllAI();
    });
    out.moves = [];
    for (let k = 0; k < 3; k++) {
      const mv = await page.evaluate(async () => {
        const D = window.__hexagoDebug;
        const t0 = performance.now();
        const r = await D.think(600);
        const elapsedMs = performance.now() - t0;
        let applied = null;
        if (r && Number.isInteger(r.move)) {
          if (r.move === -1) applied = D.pass() ? 'pass' : 'pass-failed';
          else applied = D.playMove(r.move) ? 'played' : 'illegal';
        }
        return {
          move: r && r.move, visits: r && r.visits, playouts: r && r.playouts,
          workers: r && r.workers, engineTag: r && r.engine, elapsedMs: Math.round(elapsedMs),
          applied, stones: D.state().board.filter(v => v !== 0).length,
          turn: D.state().turn, engineErr: D.engine().error,
        };
      });
      out.moves.push(mv);
      await sleep(150);
    }

    await page.evaluate(() => {
      const m = document.getElementById('setModal');
      if (m) m.classList.add('hidden');
    });
    await sleep(250);
    await page.screenshot(shot);
    out.screenshot = shot;
    out.ok = out.boot.engineVersion && out.moves.every(m => m.applied === 'played' || m.applied === 'pass') && !out.moves.some(m => m.engineErr);
    console.log(JSON.stringify(out, null, 1));
  } finally {
    if (browser) await browser.close();
  }
  process.exit(out.ok ? 0 : 2);
}

main().catch(err => { console.error(err && (err.stack || err)); process.exit(1); });
