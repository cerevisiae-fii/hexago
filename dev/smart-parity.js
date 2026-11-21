#!/usr/bin/env node
/* Engine smart dead-stone parity: compares removeDeadStonesSmart (used at
 * every scoring point in the engine) 1:1 against the PAGE's
 * detectDeadStonesSmart(), extracted from the concatenated page source and
 * run in the same sandbox the bench uses.  Random positions from real games
 * (2-6 players, all sizes) + crafted cases.
 *
 * Usage: node dev/smart-parity.js [N]     (default 120 random positions)
 */
'use strict';
const path = require('node:path');
const E = require(path.join(__dirname, 'ai-engine.js'));
const oa = require(path.join(__dirname, '..', 'bench', 'lib', 'old-ai.js'));
const ps = require(path.join(__dirname, 'page-source.js'));
const rules = require(path.join(__dirname, '..', 'bench', 'lib', 'rules.js'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const N = +(process.argv[2] || 120);
  const src = ps.readPageSource ? ps.readPageSource() : ps();
  const pageAIs = {};   // per-size sandbox (sandbox geometry is fixed at creation)
  function pageApiFor(size) {
    if (!pageAIs[size]) pageAIs[size] = oa.createOldAI({ html: src, size: size, seed: 1 });
    return pageAIs[size];
  }
  let pageSmart;
  try {
    pageSmart = pageApiFor(9).api;
    if (typeof pageSmart.detectDeadStonesSmart !== 'function') throw new Error('page smart not extractable');
  } catch (e) {
    console.error('page extraction failed:', e.message);
    process.exit(2);
  }
  const rng = mulberry32(20261121);
  let pass = 0, fail = 0, diffs = [];

  // crafted cases per size/pc
  const crafted = [];
  for (const size of [9, 13]) {
    const g = E.geometry(size);
    const map = {}; for (let i = 0; i < g.n; i++) map[g.P[i][0] + ',' + g.P[i][1]] = i;
    const c = map['0,0'];
    const b = new Int8Array(g.n);
    // two-eye alive group + one 2-lib enclosed dead group (enemy)
    const ring6 = g.NB[c];
    for (const x of ring6) b[x] = 1;             // P1 ring around center (dead-ish, no eyes... it has 1 'eye' at c)
    b[c] = 0;                                    // its eye
    // P2 chain with 2 libs inside P1's second ring (on-board anchor)
    {
      const ctr = map['2,1'];
      for (let i = 0; i < g.n; i++) if (g.dist(i, ctr) === 2) b[i] = 1;
      b[ctr] = 2; for (const x of g.NB[ctr]) b[x] = 2;
    }
    crafted.push({ size, pc: 2, board: Array.from(b) });
  }

  function checkOne(size, pc, board, label) {
    const eng = E.createEngine({ size, playerCount: pc });
    const ours = eng._deadStonesSmart(board, pc).sort((a, b) => a - b);
    const g = E.geometry(size);
    const R = rules.createRules(size, pc);
    const st = R.newState(pc);
    st.board = board.slice();
    st.playerCount = pc;
    const ai = pageApiFor(size);
    ai.sandbox.G = st;
    ai.sandbox.playerCount = pc;
    const theirs = Array.from(ai.api.detectDeadStonesSmart()).sort((a, b) => a - b);
    const same = ours.length === theirs.length && ours.every((v, i) => v === theirs[i]);
    if (same) pass++;
    else {
      fail++;
      if (diffs.length < 3) diffs.push({ label, size, pc, ours, theirs, board: board.slice().join('') });
    }
    return same;
  }

  for (const c of crafted) checkOne(c.size, c.pc, c.board, 'crafted');

  for (let k = 0; k < N; k++) {
    const size = [9, 13, 19, 25][k % 4];
    const pc = 2 + ((k / 4) | 0) % 5;
    const R = rules.createRules(size, pc);
    const st = R.newState(pc);
    const plies = 20 + ((rng() * 150) | 0);
    for (let s = 0; s < plies && !st.over; s++) {
      const lm = R.legalMoves(st);
      if (!lm.length) break;
      R.applyMove(st, lm[(rng() * lm.length) | 0]);
    }
    checkOne(size, pc, st.board, 'rand' + k);
  }

  console.log('smart dead-stone parity vs page: ' + pass + ' passed, ' + fail + ' failed' + (N + crafted.length) + ' positions');
  if (fail) {
    for (const d of diffs) console.log(JSON.stringify(d).slice(0, 400));
    process.exit(1);
  }
  console.log('ALL PARITY OK');
}

main();
