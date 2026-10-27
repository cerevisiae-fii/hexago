#!/usr/bin/env node
/**
 * HEXAGO AI engine self-test.
 *
 *   node dev/engine-selftest.js              # correctness + throughput (fast)
 *   node dev/engine-selftest.js --strength   # + 300ms vs 50ms self-play games
 *   node dev/engine-selftest.js --strength --games 4
 *
 * The rules/hash/geometry checks compare against functions EXTRACTED FROM
 * index.html at runtime, so this test fails if the engine drifts from the page.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const indexPath = path.join(repo, 'index.html');
const enginePath = path.join(__dirname, 'ai-engine.js');

const E = require(enginePath);

let passCount = 0;
let failCount = 0;

function PASS(name, detail) {
  passCount++;
  console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function FAIL(name, detail) {
  failCount++;
  console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
}
function check(name, cond, detail) {
  if (cond) PASS(name, detail); else FAIL(name, detail);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ------------------------------------------------------------------ *
 *  Extract the reference implementation from index.html
 * ------------------------------------------------------------------ */

function sliceFunction(src, header) {
  const idx = src.indexOf(header);
  if (idx < 0) throw new Error('selftest: cannot find "' + header + '" in index.html');
  const open = src.indexOf('{', idx);
  if (open < 0) throw new Error('selftest: no body for "' + header + '"');
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(idx, j + 1);
    }
  }
  throw new Error('selftest: unbalanced braces for "' + header + '"');
}

function makePageApi() {
  const src = fs.readFileSync(indexPath, 'utf8');
  const dirs = /const DIRS = \[[\s\S]*?\];/.exec(src);
  if (!dirs) throw new Error('selftest: cannot find DIRS in index.html');
  const parts = [
    dirs[0],
    sliceFunction(src, 'function build(n)'),
    sliceFunction(src, 'function hash(a)'),
    sliceFunction(src, 'function group(b, i)'),
    sliceFunction(src, 'const libCount =') + ';',
    sliceFunction(src, 'function sim(b, i, p)'),
    sliceFunction(src, 'function territoryForBoard(board)'),
    sliceFunction(src, 'function hexDist(i, j)')
  ];
  const code = [
    '"use strict";',
    'let SIDE = 5, P = [], M = {}, NB = [];',
    'let seenSet = new Set();',
    'let G = { playerCount: 3 };',
    'let playerCount = 3;',
    parts.join('\n'),
    'return {',
    '  build(n) { build(n); return { SIDE, P, M, NB }; },',
    '  hash: a => hash(a),',
    '  sim: (b, i, p) => sim(b, i, p),',
    '  setSeen: a => { seenSet = new Set(a); },',
    '  territoryForBoard: (b, pc) => { G = { playerCount: pc }; return territoryForBoard(b); },',
    '  hexDist: (i, j) => hexDist(i, j),',
    '};'
  ].join('\n');
  return new Function(code)();
}

const page = makePageApi();
const SIZES = [9, 13, 19, 25];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function makeState(size, pc, board, turn, passes, seen, out) {
  return {
    size,
    playerCount: pc,
    turn,
    board: board.slice(),
    out: (out || [false]).concat ? (out || []).slice() : [],
    passes: passes || 0,
    seen: (seen || []).slice()
  };
}

function fullOut(pc) {
  const a = new Array(pc + 1).fill(false);
  return a;
}

function randomBoard(size, pc, fill, seedRng) {
  const n = E.geometry(size).n;
  const b = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (seedRng() < fill) b[i] = 1 + ((seedRng() * pc) | 0);
  }
  return b;
}

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

function eqArr(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function nextActive(turn, pc, out) {
  let t = turn;
  for (let guard = 0; guard <= pc; guard++) {
    t = (t % pc) + 1;
    if (!out[t]) return t;
  }
  return turn;
}

function activePlayers(pc, out) {
  const list = [];
  for (let p = 1; p <= pc; p++) if (!out[p]) list.push(p);
  return list;
}

// Reference score: territory + stones (page finishScore, dead stones scored alive).
function pageScore(board, pc) {
  page.build(E._internals.sizeFromN(board.length));
  const t = page.territoryForBoard(board.slice(), pc);
  const sc = new Array(pc + 1).fill(0);
  for (let p = 1; p <= pc; p++) {
    let stones = 0;
    for (let i = 0; i < board.length; i++) if (board[i] === p) stones++;
    sc[p] = t[p] + stones;
  }
  return sc;
}

function pageLegalMoves(size, pc, board, turn, seen) {
  page.build(size);
  page.setSeen(seen || []);
  const legal = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i]) continue;
    if (page.sim(board, i, turn) !== null) legal.push(i);
  }
  legal.push(-1);
  return legal;
}

/* ------------------------------------------------------------------ *
 *  1. Geometry / index order parity
 * ------------------------------------------------------------------ */

section('1. geometry / index order (vs index.html build())');
for (const size of SIZES) {
  const pg = page.build(size);
  const g = E.geometry(size);
  const sameP = pg.P.length === g.P.length && pg.P.every((p, i) => p[0] === g.P[i][0] && p[1] === g.P[i][1]);
  const sameNB = pg.NB.length === g.NB.length && pg.NB.every((nb, i) => eqArr(nb, g.NB[i]));
  const centerOk = pg.M['0,0'] === g.center;
  let distOk = true;
  for (let i = 0; i < g.n && distOk; i += 7) {
    for (let j = 0; j < g.n; j += 11) {
      if (g.dist(i, j) !== page.hexDist(i, j)) { distOk = false; break; }
    }
  }
  check('size ' + size + ' point count', g.n === pg.P.length && g.n === 3 * g.side * (g.side - 1) + 1, 'n=' + g.n);
  check('size ' + size + ' P order identical', sameP);
  check('size ' + size + ' NB identical', sameNB);
  check('size ' + size + ' center / hexDist', centerOk && distOk);
}

/* ------------------------------------------------------------------ *
 *  2. hash parity
 * ------------------------------------------------------------------ */

section('2. board hash parity (vs index.html hash())');
{
  page.build(9);
  const rnd = mulberry32(42);
  let ok = true;
  for (let t = 0; t < 200; t++) {
    const n = E.geometry(SIZES[t % 4]).n;
    const pc = 2 + (t % 5);
    const b = new Array(n).fill(0);
    for (let i = 0; i < n; i++) if (rnd() < 0.4) b[i] = 1 + ((rnd() * pc) | 0);
    if (page.hash(b) !== E.hashBoard(b)) { ok = false; break; }
    if (page.hash(Int8Array.from(b)) !== E.hashBoard(Int8Array.from(b))) { ok = false; break; }
  }
  check('hashBoard === page hash (random boards, all sizes, Array + Int8Array)', ok);
}

/* ------------------------------------------------------------------ *
 *  3. move legality parity (occupied / suicide / captures / superko)
 * ------------------------------------------------------------------ */

section('3. root move legality parity (vs index.html sim())');
{
  let legalOk = true;
  let legalMsg = '';
  let cases = 0;
  const rnd = mulberry32(7);
  for (const size of [9, 13]) {
    const n = E.geometry(size).n;
    const g = E.geometry(size);
    for (let caseNo = 0; caseNo < 12; caseNo++) {
      const pc = 2 + (caseNo % 5);
      const board = new Array(n).fill(0);
      const stones = Math.floor(n * (0.15 + rnd() * 0.5));
      for (let s = 0; s < stones; s++) board[(rnd() * n) | 0] = 1 + ((rnd() * pc) | 0);
      const turn = 1 + ((rnd() * pc) | 0);
      // A few random previous position hashes (superko source), incl. maybe current.
      const seen = [];
      for (let s = 0; s < 3; s++) {
        const sb = board.slice();
        const cnt = 2 + ((rnd() * 5) | 0);
        for (let k = 0; k < cnt; k++) sb[(rnd() * n) | 0] = 1 + ((rnd() * pc) | 0);
        seen.push(page.hash(sb));
      }
      if (rnd() < 0.2) seen.push(page.hash(board));
      const state = makeState(size, pc, board, turn, 0, seen, fullOut(pc));
      const ours = E._internals.rootLegalMoves(state).slice().sort((a, b) => a - b);
      const ref = pageLegalMoves(size, pc, board, turn, seen).sort((a, b) => a - b);
      cases++;
      if (!eqArr(ours, ref)) {
        legalOk = false;
        legalMsg = 'size ' + size + ' case ' + caseNo + ' ours=' + ours.length + ' ref=' + ref.length;
        break;
      }
    }
    if (!legalOk) break;
  }
  check('random positions: legal move set (incl. pass) identical', legalOk, legalMsg || (cases + ' positions'));

  // --- targeted: atari capture, suicide, superko ---
  const n9 = E.geometry(9).n;
  const c = E.geometry(9).center;
  // atari: black stone at center, 5 of its neighbours white -> liberty = last neighbour
  const nb = E.geometry(9).NB[c];
  const atariBoard = new Array(n9).fill(0);
  atariBoard[c] = 1;
  for (let k = 0; k < 5; k++) atariBoard[nb[k]] = 2;
  const liberty = nb[5];
  const stAtari = makeState(9, 2, atariBoard, 2, 0, [], fullOut(2));
  const atariOurs = E._internals.rootLegalMoves(stAtari);
  check('atari capture move is legal (engine + page)',
    atariOurs.indexOf(liberty) >= 0 && pageLegalMoves(9, 2, atariBoard, 2, []).indexOf(liberty) >= 0);
  // page sim really captures
  page.build(9); page.setSeen([]);
  const capRes = page.sim(atariBoard, liberty, 2);
  check('capture removes the atari group in reference sim', !!capRes && capRes.cap.length === 1 && capRes.a[c] === 0);

  // suicide: empty centre fully surrounded by white, black to move -> illegal
  const suicideBoard = new Array(n9).fill(0);
  for (const x of nb) suicideBoard[x] = 2;
  const stSui = makeState(9, 2, suicideBoard, 1, 0, [], fullOut(2));
  const suiOurs = E._internals.rootLegalMoves(stSui);
  check('suicide move rejected (engine + page)',
    suiOurs.indexOf(c) < 0 && pageLegalMoves(9, 2, suicideBoard, 1, []).indexOf(c) < 0);

  // superko: capture is illegal when the resulting position was already seen
  page.build(9); page.setSeen([]);
  const cap = page.sim(atariBoard, liberty, 2);
  const superkoSeen = [page.hash(cap.a)];
  const stSk = makeState(9, 2, atariBoard, 2, 0, superkoSeen, fullOut(2));
  const skOurs = E._internals.rootLegalMoves(stSk);
  check('superko: capturing move rejected when result was already played (engine + page)',
    skOurs.indexOf(liberty) < 0 && pageLegalMoves(9, 2, atariBoard, 2, superkoSeen).indexOf(liberty) < 0);

  // occupied cells are never returned
  const occBoard = new Array(n9).fill(0);
  for (let i = 0; i < n9; i += 2) occBoard[i] = (i % 3) + 1;
  const stOcc = makeState(9, 3, occBoard, 1, 0, [], fullOut(3));
  const occOurs = E._internals.rootLegalMoves(stOcc).filter(m => m >= 0);
  check('occupied cells never returned', occOurs.every(m => occBoard[m] === 0));
}

/* ------------------------------------------------------------------ *
 *  4. scoring parity (territory + stones)
 * ------------------------------------------------------------------ */

section('4. scoring parity (territory + stones vs page finishScore rules)');
{
  const rnd = mulberry32(99);
  let ok = true, msg = '';
  for (const size of [9, 13, 19]) {
    const n = E.geometry(size).n;
    for (let t = 0; t < 15; t++) {
      const pc = 2 + (t % 5);
      const board = randomBoard(size, pc, 0.25 + rnd() * 0.5, rnd);
      // try to create enclosed regions: fill some rings not necessary; random covers
      const ours = E._internals.scoreBoard(board, pc);
      const ref = pageScore(board, pc);
      if (!eqArr(ours, ref)) {
        ok = false; msg = 'size ' + size + ' trial ' + t + ' ours=' + JSON.stringify(ours) + ' ref=' + JSON.stringify(ref);
        break;
      }
    }
    if (!ok) break;
  }
  check('scoreBoard === territory + stones (2..6 players, sizes 9/13/19)', ok, msg);

  // single-colour enclosed region counted exactly
  const g = E.geometry(9);
  const ringBoard = new Array(g.n).fill(0);
  for (let i = 0; i < g.n; i++) if (g.dist(i, g.center) === 3) ringBoard[i] = 1;
  const sc = E._internals.scoreBoard(ringBoard, 2);
  const ref = pageScore(ringBoard, 2);
  check('enclosed single-colour region territory exact', eqArr(sc, ref), JSON.stringify(sc));
}

/* ------------------------------------------------------------------ *
 *  5. pass / endgame and always-legal behaviour
 * ------------------------------------------------------------------ */

section('5. pass / endgame / always-legal');
{
  const g = E.geometry(9);
  const n = g.n;
  const empty = new Array(n).fill(0);
  const mid = new Array(n).fill(0);
  mid[g.center] = 1; mid[g.NB[g.center][0]] = 2; mid[g.NB[g.center][1]] = 1;

  // full board: only pass can be played; think must return -1 and stay legal
  const full = new Array(n).fill(0);
  for (let i = 0; i < n; i++) full[i] = 1 + (i % 2);
  const stFull = makeState(9, 2, full, 1, 0, [], fullOut(2));
  const engFull = E.createEngine({ size: 9, playerCount: 2 });
  const rFull = engFull.think(stFull, { budgetMs: 100, seed: 5 });
  check('full board: think() returns pass (-1)', rFull.move === -1, 'move=' + rFull.move);
  check('full board: board not mutated by think()', eqArr(stFull.board, full));

  // game already ended by passes: think is a no-op pass with no search
  const stOver = makeState(9, 2, empty, 1, 2, [], fullOut(2));
  const rOver = E.createEngine({ size: 9, playerCount: 2 }).think(stOver, { budgetMs: 100, seed: 5 });
  check('passes >= active players: think() returns pass with 0 visits/playouts',
    rOver.move === -1 && rOver.visits === 0 && rOver.playouts === 0);

  // after an opponent pass the root pass must be offered as a candidate.
  // Use a crowded board so all (few) root moves are expanded inside the budget.
  const rndp = mulberry32(5150);
  const late = new Array(n).fill(0);
  for (let i = 0; i < n; i++) if (rndp() < 0.9) late[i] = 1 + ((rndp() * 2) | 0);
  const rPass = E.createEngine({ size: 9, playerCount: 2 }).think(makeState(9, 2, late, 2, 1, [], fullOut(2)), { maxPlayouts: 400, seed: 11 });
  check('after a pass, pass is among root candidates', rPass.bestMoves.some(m => m.move === -1),
    JSON.stringify(rPass.bestMoves.map(m => m.move)));

  // time budget respected
  const engB = E.createEngine({ size: 9, playerCount: 2 });
  const t0 = Date.now();
  const rB = engB.think(makeState(9, 2, mid, 1, 0, [], fullOut(2)), { budgetMs: 150, seed: 3 });
  const elapsed = Date.now() - t0;
  check('budgetMs=150 respected', elapsed <= 150 + 120, 'elapsed=' + elapsed + 'ms');
  check('time-limited search always returns a legal move', rB.move === -1 || mid[rB.move] === 0);

  // tiny budget on many random positions: never illegal, never crash, board untouched
  const rnd = mulberry32(2024);
  let allLegal = true, allUntouched = true, msg = '';
  for (let t = 0; t < 12; t++) {
    const size = [9, 13][t % 2];
    const gg = E.geometry(size);
    const pc = 2 + (t % 5);
    const board = randomBoard(size, pc, 0.1 + rnd() * 0.6, rnd);
    const turn = 1 + ((rnd() * pc) | 0);
    const passes = rnd() < 0.3 ? 1 : 0;
    const state = makeState(size, pc, board, turn, passes, [], fullOut(pc));
    const before = board.slice();
    let r;
    try {
      r = E.createEngine({ size, playerCount: pc }).think(state, { budgetMs: 5, seed: 100 + t });
    } catch (err) {
      allLegal = false; msg = 'crash: ' + err.message; break;
    }
    const ref = pageLegalMoves(size, pc, board, turn, []);
    if (r.move !== -2 && ref.indexOf(r.move) < 0) { allLegal = false; msg = 'size ' + size + ' move=' + r.move; break; }
    if (!eqArr(board, before)) allUntouched = false;
    if (r.visits !== r.playouts) { /* visits can exceed playouts via tree reuse; fine */ }
  }
  check('tiny budget on random positions: always page-legal', allLegal, msg);
  check('think() never mutates state.board', allUntouched);
}

/* ------------------------------------------------------------------ *
 *  6. determinism (seed + maxPlayouts)
 * ------------------------------------------------------------------ */

section('6. determinism (seed + maxPlayouts)');
{
  const g = E.geometry(9);
  const mid = new Array(g.n).fill(0);
  mid[g.center] = 1; mid[g.NB[g.center][2]] = 2; mid[g.NB[g.center][4]] = 1; mid[g.NB[g.center][0]] = 2;
  const st = makeState(9, 2, mid, 2, 0, [], fullOut(2));
  const sig = r => JSON.stringify({ m: r.move, v: r.visits, p: r.playouts, w: r.winrate, val: r.value, b: r.bestMoves, rm: r.rootMoves });
  const a = E.createEngine({ size: 9, playerCount: 2 }).think(st, { maxPlayouts: 600, seed: 12345 });
  const b = E.createEngine({ size: 9, playerCount: 2 }).think(st, { maxPlayouts: 600, seed: 12345 });
  check('same seed+maxPlayouts => identical move/visits/winrate/bestMoves', sig(a) === sig(b));
  check('maxPlayouts is an exact cap', a.playouts === 600 && a.visits >= 600, 'playouts=' + a.playouts + ' visits=' + a.visits);

  // --- rootMoves: full root-child statistics (used for root-parallel merging) ---
  {
    const g2 = E.geometry(9);
    const emptyB = new Array(g2.n).fill(0);
    const rmState = { size: 9, playerCount: 2, turn: 1, board: emptyB, out: fullOut(2), passes: 0, seen: [] };
    const rm = E.createEngine({ size: 9, playerCount: 2 }).think(rmState, { maxPlayouts: 800, seed: 4242 });
    const isArr = Array.isArray(rm.rootMoves);
    const okFields = isArr && rm.rootMoves.every(m =>
      Number.isInteger(m.move) && m.visits > 0 &&
      typeof m.winrate === 'number' && m.winrate >= 0 && m.winrate <= 1 &&
      typeof m.value === 'number' && m.value >= -1 && m.value <= 1);
    const sum = isArr ? rm.rootMoves.reduce((a, m) => a + m.visits, 0) : -1;
    const covered = isArr && rm.bestMoves.every(b => rm.rootMoves.some(m => m.move === b.move));
    check('result.rootMoves present and well formed ({move, visits, winrate, value})', isArr && okFields);
    check('rootMoves covers all expanded root children (61-point empty board)', isArr && rm.rootMoves.length >= 50, isArr ? rm.rootMoves.length + ' moves' : 'missing');
    check('rootMoves visits sum <= result.visits', isArr && sum <= rm.visits, sum + ' <= ' + rm.visits);
    check('bestMoves is a subset of rootMoves', covered);
  }

  // tree reuse must not break legality or crash: play a short self-play with one engine per seat
  const eng1 = E.createEngine({ size: 9, playerCount: 2 });
  const board = new Array(g.n).fill(0);
  const seen = [];
  const out = fullOut(2);
  let turn = 1, passes = 0, moves = 0, okReuse = true;
  while (moves < 40 && passes < 2) {
    const state = { size: 9, playerCount: 2, turn, board: board.slice(), out: out.slice(), passes, seen: seen.slice() };
    const r = eng1.think(state, { maxPlayouts: 120, seed: 777 + moves });
    const rmSum = (r.rootMoves || []).reduce((a, m) => a + m.visits, 0);
    if (!Array.isArray(r.rootMoves) || rmSum > r.visits) okReuse = false;
    const ref = pageLegalMoves(9, 2, board, turn, seen);
    if (r.move !== -1 && ref.indexOf(r.move) < 0) { okReuse = false; break; }
    if (r.move === -1) { passes++; if (passes >= 2) break; turn = (turn % 2) + 1; }
    else {
      page.build(9); page.setSeen(seen);
      const rr = page.sim(board, r.move, turn);
      if (!rr) { okReuse = false; break; }
      for (const x of rr.cap) { /* capture count not used by engine state */ }
      board.length = 0; Array.prototype.push.apply(board, rr.a);
      seen.push(page.hash(board));
      passes = 0; turn = (turn % 2) + 1;
    }
    moves++;
  }
  check('tree reuse across consecutive think() calls: 40 moves played, all legal', okReuse && moves > 0, moves + ' moves');
}

/* ------------------------------------------------------------------ *
 *  6b. multi-player (3 seats) self-play legality
 * ------------------------------------------------------------------ */
section('6b. 3-player game: engine decides, page validates every move');
{
  page.build(9);
  const g = E.geometry(9);
  const pc = 3;
  const out = [false, false, false, false];
  const engines = [null, E.createEngine({ size: 9, playerCount: 3 }), E.createEngine({ size: 9, playerCount: 3 }), E.createEngine({ size: 9, playerCount: 3 })];
  let board = new Array(g.n).fill(0);
  const seen = [];
  let turn = 1, passes = 0, moves = 0, ok = true, msg = '';
  while (moves < 120 && passes < 3) {
    const state = { size: 9, playerCount: pc, turn, board: board.slice(), out: out.slice(), passes, seen: seen.slice() };
    let r;
    try { r = engines[turn].think(state, { maxPlayouts: 90, seed: 500 + moves * 13 + turn }); }
    catch (err) { ok = false; msg = 'crash ' + err.message; break; }
    if (r.move === -1) {
      passes++;
      turn = nextActive(turn, pc, out);
    } else {
      page.setSeen(seen);
      const sim = page.sim(board, r.move, turn);
      if (!sim) { ok = false; msg = 'illegal move ' + r.move + ' by p' + turn; break; }
      board = sim.a;
      seen.push(page.hash(board));
      passes = 0;
      turn = nextActive(turn, pc, out);
    }
    moves++;
  }
  check('3-player: engine moves are page-legal, no crash', ok && moves > 0, msg || (moves + ' moves'));
}

/* ------------------------------------------------------------------ *
 *  7. throughput on the 61-point board
 * ------------------------------------------------------------------ */

section('7. throughput (61-point board, Node ' + process.version + ')');
{
  const g = E.geometry(9);
  const rnd = mulberry32(31337);
  const mid = new Array(g.n).fill(0);
  let placed = 0;
  while (placed < 14) {
    const i = (rnd() * g.n) | 0;
    if (!mid[i]) { mid[i] = 1 + (placed % 2); placed++; }
  }
  const st = makeState(9, 2, mid, 1, 0, [], fullOut(2));
  const eng = E.createEngine({ size: 9, playerCount: 2 });

  // warm-up (JIT)
  eng.think(st, { maxPlayouts: 400, seed: 1 });

  const N = 2000;
  const t0 = process.hrtime.bigint();
  const r = eng.think(st, { maxPlayouts: N, seed: 2 });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const pps = N / (ms / 1000);
  console.log('      measured: ' + pps.toFixed(0) + ' playouts/sec  (' + N + ' playouts in ' + ms.toFixed(1) + ' ms, ' + (E.geometry(9).n) + ' points)');
  console.log('      elapsedMs from result: ' + r.elapsedMs.toFixed(1) + '  move=' + r.move + '  winrate=' + r.winrate.toFixed(3));
  check('throughput >= 3000 playouts/sec on 61 points', pps >= 3000, pps.toFixed(0) + ' pps');

  // empty board throughput (longer rollouts) reported for reference
  const empty = new Array(g.n).fill(0);
  const stE = makeState(9, 2, empty, 1, 0, [], fullOut(2));
  eng.think(stE, { maxPlayouts: 300, seed: 3 });
  const t2 = process.hrtime.bigint();
  eng.think(stE, { maxPlayouts: 1200, seed: 4 });
  const t3 = process.hrtime.bigint();
  const msE = Number(t3 - t2) / 1e6;
  console.log('      empty-board reference: ' + (1200 / (msE / 1000)).toFixed(0) + ' playouts/sec (' + msE.toFixed(1) + ' ms)');

  // also report larger boards
  for (const size of [13, 19, 25]) {
    const gg = E.geometry(size);
    const b = new Array(gg.n).fill(0);
    let pcount = 0;
    while (pcount < Math.min(20, gg.n >> 2)) {
      const i = (rnd() * gg.n) | 0;
      if (!b[i]) { b[i] = 1 + (pcount % 2); pcount++; }
    }
    const e2 = E.createEngine({ size, playerCount: 2 });
    const stt = makeState(size, 2, b, 1, 0, [], fullOut(2));
    e2.think(stt, { maxPlayouts: 100, seed: 5 });
    const M = size >= 19 ? 300 : 600;
    const s0 = process.hrtime.bigint();
    e2.think(stt, { maxPlayouts: M, seed: 6 });
    const s1 = process.hrtime.bigint();
    const mms = Number(s1 - s0) / 1e6;
    console.log('      size ' + size + ' (' + gg.n + ' points): ' + (M / (mms / 1000)).toFixed(0) + ' playouts/sec');
  }
}

/* ------------------------------------------------------------------ *
 *  8. packaging / environment checks
 * ------------------------------------------------------------------ */

section('8. packaging');
{
  const src = fs.readFileSync(enginePath, 'utf8');
  check('module exports geometry/createEngine/hashBoard/version',
    typeof E.geometry === 'function' && typeof E.createEngine === 'function' &&
    typeof E.hashBoard === 'function' && typeof E.version === 'string');
  check('source contains no "</script>" (safe to inline in index.html)', src.indexOf('</script>') < 0);
  check('source contains no require()/document/window access', !/\brequire\s*\(/.test(src) && !/\bdocument\./.test(src) && !/\bwindow\./.test(src));
  let workerApi = null;
  try {
    workerApi = new Function('self', '"use strict";\n' + src + '\nreturn self.HexagoAI;')({});
  } catch (err) { workerApi = null; }
  check('worker-style attach: new Function("self", src).HexagoAI works',
    !!workerApi && typeof workerApi.createEngine === 'function' && typeof workerApi.think === 'undefined');
  let workerThink = null;
  try {
    const api = workerApi;
    const eng = api.createEngine({ size: 9, playerCount: 2 });
    workerThink = eng.think({ size: 9, playerCount: 2, turn: 1, board: new Array(61).fill(0), out: [false, false, false], passes: 0, seen: [] }, { maxPlayouts: 50, seed: 9 });
  } catch (err) { workerThink = null; }
  check('worker API can create an engine and think()', !!workerThink && typeof workerThink.move === 'number');
}

/* ------------------------------------------------------------------ *
 *  9. optional strength: 300ms vs 50ms self-play on 61 points
 * ------------------------------------------------------------------ */

function playSelfPlayGame(size, pc, budgetStrong, budgetWeak, strongSeat, seedBase, maxMoves) {
  page.build(size);
  const g = E.geometry(size);
  const n = g.n;
  let board = new Array(n).fill(0);
  const out = fullOut(pc);
  const seen = [];
  const engines = [null];
  for (let p = 1; p <= pc; p++) engines.push(E.createEngine({ size, playerCount: pc }));
  const budgets = [0];
  for (let p = 1; p <= pc; p++) budgets.push(p === strongSeat ? budgetStrong : budgetWeak);
  const seeds = [0];
  for (let p = 1; p <= pc; p++) seeds.push((seedBase * 131 + p * 7919) | 0);
  let turn = 1, passes = 0, moves = 0, illegal = 0, crash = null;
  let totalMs = 0;
  while (moves < maxMoves) {
    const active = activePlayers(pc, out).length;
    if (active <= 1) break;
    if (passes >= active) break;
    const state = {
      size, playerCount: pc, turn,
      board: board.slice(), out: out.slice(), passes, seen: seen.slice()
    };
    let res;
    const t0 = process.hrtime.bigint();
    try {
      res = engines[turn].think(state, { budgetMs: budgets[turn], seed: seeds[turn] + moves * 104729 });
    } catch (err) {
      crash = String(err && err.message || err);
      break;
    }
    const t1 = process.hrtime.bigint();
    totalMs += Number(t1 - t0) / 1e6;
    let mv = res && Number.isInteger(res.move) ? res.move : -3;
    page.setSeen(seen);
    if (mv === -1) {
      passes++;
      turn = nextActive(turn, pc, out);
    } else if (mv >= 0 && !board[mv] && page.sim(board, mv, turn) !== null) {
      const r = page.sim(board, mv, turn);
      board = r.a;
      seen.push(page.hash(board));
      passes = 0;
      turn = nextActive(turn, pc, out);
    } else {
      illegal++;
      // fall back to a pass so the game can still finish and be reported
      passes++;
      turn = nextActive(turn, pc, out);
    }
    moves++;
  }
  const sc = pageScore(board, pc);
  const active = activePlayers(pc, out);
  let best = -1;
  for (const p of active) if (best < 0 || sc[p] > sc[best]) best = p;
  const winners = active.filter(p => sc[p] === sc[best]);
  return { board, scores: sc, moves, illegal, crash, winners, best, totalMs, budgetStrong, budgetWeak, strongSeat };
}

function runStrength(games) {
  section('9. strength: ' + (300) + 'ms vs ' + (50) + 'ms self-play (61-point board, 2 players)');
  page.build(9);
  let strongWins = 0, weakWins = 0, draws = 0, illegal = 0, crashes = 0;
  const gameResults = [];
  for (let gi = 0; gi < games; gi++) {
    const strongSeat = (gi % 2) + 1; // alternate seats
    const r = playSelfPlayGame(9, 2, 300, 50, strongSeat, 9000 + gi * 17, 260);
    if (r.crash) crashes++;
    illegal += r.illegal;
    const strongScore = r.scores[strongSeat];
    const other = strongSeat === 1 ? 2 : 1;
    const weakScore = r.scores[other];
    let verdict;
    if (r.crash) verdict = 'CRASH';
    else if (strongScore > weakScore) { strongWins++; verdict = 'strong wins'; }
    else if (strongScore < weakScore) { weakWins++; verdict = 'weak wins'; }
    else { draws++; verdict = 'draw'; }
    gameResults.push(verdict);
    console.log('      game ' + (gi + 1) + ': strong seat ' + strongSeat + ' -> ' + verdict +
      '  scores=' + JSON.stringify({ strong: strongScore, weak: weakScore }) +
      '  moves=' + r.moves + ' illegal=' + r.illegal + ' avgMoveMs=' + (r.totalMs / Math.max(1, r.moves)).toFixed(0));
  }
  console.log('      summary: strong(300ms) ' + strongWins + 'W / weak(50ms) ' + weakWins + 'W / ' + draws + 'D, illegal=' + illegal + ', crashes=' + crashes);
  check('300ms engine beats 50ms engine in self-play (more wins, no illegal moves)',
    strongWins > weakWins && illegal === 0 && crashes === 0,
    strongWins + 'W-' + weakWins + 'L-' + draws + 'D');
}

/* ------------------------------------------------------------------ *
 *  main
 * ------------------------------------------------------------------ */

console.log('HEXAGO engine self-test — engine: ' + E.version + ', node ' + process.version);
console.log('engine file: ' + enginePath);
console.log('reference:   ' + indexPath);

const args = process.argv.slice(2);
const doStrength = args.indexOf('--strength') >= 0;
let games = 2;
const gi = args.indexOf('--games');
if (gi >= 0 && args[gi + 1]) games = Math.max(1, parseInt(args[gi + 1], 10) || 2);

if (doStrength) {
  try {
    runStrength(games);
  } catch (err) {
    FAIL('strength self-play runner', String((err && err.stack) || err));
  }
}

console.log('\n----------------------------------------');
console.log((failCount === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + passCount + ' passed, ' + failCount + ' failed');
console.log('----------------------------------------');
process.exit(failCount === 0 ? 0 : 1);
