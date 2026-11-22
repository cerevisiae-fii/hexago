#!/usr/bin/env node
/* Behaviour probes for the HEXAGO engine (v2 baseline vs candidates).
 * Each probe builds a crafted position, asks the engine to move, and prints
 * what it chose + how the point is classified (own territory / enemy territory /
 * neutral / capture / save). Run: node dev/probe-behavior.js [--time 300] [--engine dev/ai-engine.js]
 */
'use strict';
const path = require('path');
const ENGINE_FILE = process.argv.includes('--engine')
  ? path.resolve(process.argv[process.argv.indexOf('--engine') + 1])
  : path.resolve(__dirname, 'ai-engine.js');
const TIME_MS = process.argv.includes('--time')
  ? +(process.argv[process.argv.indexOf('--time') + 1] || 300)
  : 300;
const ASSERT = process.argv.includes('--assert');
const AI = require(ENGINE_FILE);
let failures = 0;
function checkProbe(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!cond) failures++;
}

function mk(size, pc) {
  const g = AI.geometry(size);
  const map = Object.create(null);
  for (let i = 0; i < g.n; i++) map[g.P[i][0] + ',' + g.P[i][1]] = i;
  return { g, map, eng: AI.createEngine({ size, playerCount: pc }) };
}
function setStone(B, map, q, r, c) {
  const i = map[q + ',' + r];
  if (i === undefined) throw new Error('off board ' + q + ',' + r);
  B[i] = c;
  return i;
}
function wall(B, map, q, c, R) { // full line at coordinate q
  const pts = [];
  for (let r = -R; r <= R; r++) if (Math.abs(q + r) <= R) pts.push(setStone(B, map, q, r, c));
  return pts;
}
function ring(B, map, q, r, c) { // 6 stones around (q,r) (interior left empty)
  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  for (const [dq, dr] of DIRS) setStone(B, map, q + dq, r + dr, c);
}
function think(ctx, B, turn, pc, extra) {
  const state = Object.assign({ board: Array.from(B), turn, playerCount: pc, out: new Array(pc + 1).fill(false), passes: 0, seen: [] }, extra || {});
  return ctx.eng.think(state, { budgetMs: TIME_MS, seed: 12345, resignThreshold: 0.02 });
}
// classify a point on a board (compact, page-semantics territory owner)
function classifyPoint(B, g, i) {
  const reg = [i], seen = new Set([i]), cols = new Set();
  for (let k = 0; k < reg.length; k++) for (const nb of g.NB[reg[k]]) {
    if (!B[nb]) { if (!seen.has(nb)) { seen.add(nb); reg.push(nb); } } else cols.add(B[nb]);
  }
  return { size: reg.length, owner: cols.size === 1 ? [...cols][0] : 0, cols: [...cols] };
}
function show(B, g, mv, label) {
  if (mv === -1) return console.log('  -> PASS (' + label + ')');
  if (mv === -2) return console.log('  -> RESIGN (' + label + ')');
  const cl = classifyPoint(B, g, mv);
  const [q, r] = g.P[mv];
  let kind = cl.owner === 0 ? 'neutral/dame(' + cl.cols.join('') + ')' : (cl.owner + '-territory');
  if (cl.size === 1) kind += ' [single-point]';
  console.log('  -> ' + mv + ' (' + q + ',' + r + ') region=' + cl.size + 'pts ' + kind + '  (' + label + ')');
}

console.log('== engine: ' + AI.version + ' budget=' + TIME_MS + 'ms ==\n');

/* ---------- Probe A: own big territory ---------- */
// 13-board. P1 wall at q=0 -> everything q>=1 is P1 territory (big).
// P2/P3 each have a small 6-ring elsewhere. P1 to move: fill own 57-pt
// territory, play neutral, or pass?
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  wall(B, map, 0, 1, 6);
  ring(B, map, -3, 3, 2);
  ring(B, map, -2, -2, 3);
  console.log('A) P1 big settled territory (q>=1, ~57pts), neutral left side. P1 to move:');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  const cl = classifyPoint(B, g, res.move >= 0 ? res.move : 0);
  console.log('   territory sizes: q>=1 strip P1-owned expected; chosen-region size=' + cl.size + ' owner=' + cl.owner);
  checkProbe('Probe A: does not fill own big settled territory', res.move >= 0 && cl.owner !== 1, 'owner=' + cl.owner);
}

/* ---------- Probe B: invasion of a solid enemy territory ---------- */
// 13-board. P2 wall at q=-1 -> strip q<=-2 is P2 territory (~40pts).
// P1 wall at q=2 -> strip q>=3 is P1 territory. Neutral strip q in {0,1}.
// P1 to move: invade P2's big-but-solid strip (stone will die) or play neutral?
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  wall(B, map, 2, 1, 6);
  wall(B, map, -1, 2, 6);
  ring(B, map, 0, -3, 3); // P3 ring in the neutral strip
  console.log('B) P2 owns big strip q<=-2; P1 to move. invade?');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  const cl = res.move >= 0 ? classifyPoint(B, g, res.move) : { owner: 0 };
  checkProbe('Probe B: prefers neutral over blind invasion/own-fill', res.move >= 0 && cl.owner === 0, 'owner=' + cl.owner);
}

/* ---------- Probe C (report-only): the "attack" question under area scoring ----------
 * Synthetic "must attack" positions turn out to be traps under correct play:
 * - a fully enclosed 1-2 lib group is already scorer-dead (the page's smart
 *   scorer removes it at game end), so CAPTURING IT GAINS ZERO - ignoring it
 *   is optimal, not a weakness;
 * - a group with an escape is a genuine fight, and whether to commit to it
 *   is a strategic judgement that only the search can price.
 * So there is no simple "must capture" probe.  The attack behaviour is
 * measured where it is real: the A/B winrate against the previous engine
 * (the shipped build wins decisively) and the self-play style metrics
 * (attack moves / defence moves / captures per game).  This probe therefore
 * only REPORTS what the engine does with a 3-liberty group near an escape
 * gap, for eyeball comparison between builds.
 */
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  const ctr = map['2,0'];
  for (let i = 0; i < g.n; i++) if (g.dist(i, ctr) === 3) B[i] = 1;
  const inner = [];
  for (let i = 0; i < g.n; i++) if (g.dist(i, ctr) <= 2) inner.push(i);
  const chain = inner.slice(0, 6);
  for (const i of chain) B[i] = 2;
  let libs = () => { const s = new Set(); for (const i of chain) for (const nb of g.NB[i]) if (!B[nb]) s.add(nb); return s; };
  for (const i of inner) {
    if (B[i]) continue;
    if (libs().size <= 1) break;
    B[i] = 1;
  }
  const capPt = [...libs()][0];
  for (const nb of g.NB[capPt]) if (B[nb] === 1) B[nb] = 0;
  const L = libs();
  ring(B, map, -1, 0, 3);
  console.log('C) [report] P2 ' + chain.length + '-stone chain, ' + L.size + ' libs, escape gap open. Engine choice:');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  const onLib = res.move >= 0 && L.has(res.move);
  console.log('   (liberty filled=' + onLib + ', liberties: ' + [...L].map(l => g.P[l].join(',')).join(' ') + ')');
}

/* ---------- Probe D: fully settled small regions -> pass? ---------- */
// 13-board. P1 wall at q=4 -> strip q>=5 is a SMALL P1 territory (~7pts).
// P2 wall at q=1 -> strip q>=2? no: neutral strip q in {2,3} between P1 q=4
// and P2 q=1 walls. P3 wall q=-2, its territory q<=-3 small-ish.
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  wall(B, map, 4, 1, 6);
  wall(B, map, 1, 2, 6);
  wall(B, map, -2, 3, 6);
  console.log('D) three strips, each walled. P1 to move (territory q>=5 ~small). pass?');
  for (const p of [1, 2, 3]) {
    const res = think({ g, map, eng }, B, p, pc);
    show(B, g, res.move, 'P' + p + ' res.playouts=' + res.playouts);
    if (res.move >= 0) { B[res.move] = p; }
    else if (res.move === -2) break;
  }
}

/* ---------- Probe E: 2-player settled, only own-territory fills left ---------- */
// 9-board. P1 wall q=1, P2 wall q=-1: strips q>=2 (P1) and q<=-2 (P2) are
// territories, no neutral points left except the q=0 line? wall at q=1 and -1
// leave the q=0 line itself: is it P1's wall? no: walls AT q=1 (P1 stones).
// q=0 line is empty, bordered by both -> dame. Let's instead make walls at
// q=0 (P1) and q=-3 (P2) with the strips owned: q>=1 P1 (small), q<=-4 P2,
// neutral q in {-2,-1}. P1 to move with everything settled except dame.
{
  const pc = 2, { g, map, eng } = mk(9, pc);
  const B = new Int8Array(g.n);
  wall(B, map, 0, 1, 4);
  wall(B, map, -3, 2, 4);
  console.log('E) 2P 9-board: P1 territory q>=1, P2 territory q<=-4, neutral strip q=-2..-1. P1 to move:');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  const clE = res.move >= 0 ? classifyPoint(B, g, res.move) : { owner: -1 };
  console.log('   (dame points should be taken first, then pass)');
  checkProbe('Probe E: plays neutral dame first, never fills own territory', res.move >= 0 && clE.owner === 0, 'owner=' + clE.owner);
}

/* ---------- Probe F: 2-eye living group must NEVER fill its own eye ---------- */
// Regression test for v2.2.0 (where mvStab marked 2-lib living groups as weak
// and high visit counts bypassed the eye guard).
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  // Fill most of the board with P2 except a solid P1 2-eye living group + 2 dame points
  for (let i = 0; i < g.n; i++) B[i] = 2;
  const eye1 = map['0,0'], eye2 = map['2,0'];
  const p1Stones = new Set();
  for (const nb of g.NB[eye1]) p1Stones.add(nb);
  for (const nb of g.NB[eye2]) p1Stones.add(nb);
  for (const s of p1Stones) B[s] = 1;
  B[eye1] = 0; B[eye2] = 0;
  // Also open a few enemy/neutral points so the board isn't frozen
  const d1 = map['-4,2'], d2 = map['-3,2'];
  B[d1] = 0; B[d2] = 0; B[map['-5,2']] = 3;
  console.log('F) 3P 13-board: P1 has a 2-eye living group (2 liberties, both eyes). Must never fill either eye:');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  checkProbe('Probe F: never fills an eye of a 2-eye living group', res.move !== eye1 && res.move !== eye2, 'move=' + res.move + ' eyes=' + eye1 + ',' + eye2);
}

/* ---------- Probe G: opening coherence / anti-scattering (3P 13-board) ---------- */
// Play the first 15 moves (5 stones per player) across 3 seeds and verify that
// stones form coherent living frameworks rather than scattering isolated stones
// all over the board or hugging the 1st-line edge.
{
  const pc = 3, size = 13, g = AI.geometry(size);
  const radius = g.side - 1;
  let ownDistSum = 0, ownDistN = 0, isolatedFar = 0, edgeMoves = 0, totalMoves = 0;
  for (const seedBase of [101, 202, 303]) {
    const engines = [null, AI.createEngine({ size, playerCount: pc }), AI.createEngine({ size, playerCount: pc }), AI.createEngine({ size, playerCount: pc })];
    const B = new Int8Array(g.n);
    const out = [false, false, false, false];
    let turn = 1;
    for (let m = 0; m < 15; m++) {
      const res = engines[turn].think({ size, playerCount: pc, turn, board: Array.from(B), out, passes: 0, seen: [] }, { budgetMs: Math.min(TIME_MS, 200), seed: seedBase + m * 17 });
      const mv = res.move;
      if (mv < 0) break;
      // Measure nearest own stone before placing
      let bestOwn = 99;
      for (let i = 0; i < g.n; i++) if (B[i] === turn) { const d = g.dist(i, mv); if (d < bestOwn) bestOwn = d; }
      if (bestOwn < 99) {
        ownDistSum += bestOwn; ownDistN++;
        if (bestOwn >= 6) isolatedFar++;
      }
      if (g.NB[mv].length < 6) edgeMoves++;
      totalMoves++;
      B[mv] = turn;
      turn = (turn % pc) + 1;
    }
  }
  const meanOwn = ownDistN ? (ownDistSum / ownDistN) : 0;
  const isoPct = ownDistN ? (100 * isolatedFar / ownDistN) : 0;
  const edgePct = totalMoves ? (100 * edgeMoves / totalMoves) : 0;
  console.log('G) 3P 13-board opening coherence (3 seeds x 15 moves): meanNearestOwn=' + meanOwn.toFixed(2) +
    ' isolated(>=6)=' + isolatedFar + '/' + ownDistN + ' (' + isoPct.toFixed(1) + '%)' +
    ' 1st-line-edge=' + edgeMoves + '/' + totalMoves + ' (' + edgePct.toFixed(1) + '%)');
  checkProbe('Probe G1: coherent opening framework (meanNearestOwn <= 3.6)', meanOwn <= 3.6, meanOwn.toFixed(2));
  checkProbe('Probe G2: low isolated stone scattering (dist>=6 <= 20%)', isoPct <= 20, isoPct.toFixed(1) + '%');
  checkProbe('Probe G3: does not hug 1st-line edge in opening (<= 25%)', edgePct <= 25, edgePct.toFixed(1) + '%');
}

/* ---------- Probe H: dead-invasion & already-dead-stone eradication (3P 13-board) ---------- */
// H1: 10-pt pocket enclosed inside a 2-eye living P2 wall (no dame anywhere) -> P1 must PASS
//     even at high search budgets (1500ms, simulating 12s browser depth).
// H2: 1 already-smart-dead P1 stone inside P2's 5-pt 2-eye pocket -> BOTH P1 and P2 must PASS.
// H3: 1 trapped 0-eye P1 stone inside P2's 10-pt 2-eye pocket -> P1 must PASS (no piling).
{
  const pc = 3, { g, map } = mk(13, pc);
  const B = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const [q] = g.P[i];
    if (q >= 3) B[i] = 1;
    else if (q <= -1) B[i] = 2;
    else B[i] = 3;
  }
  setStone(B, map, 4, -2, 0); setStone(B, map, 4, 1, 0);   // P1 2 eyes
  setStone(B, map, 1, -3, 0); setStone(B, map, 1, 2, 0);   // P3 2 eyes
  setStone(B, map, -5, 1, 0); setStone(B, map, -5, 4, 0);  // P2 2 eyes
  const pocket = [[-2,-1],[-2,0],[-2,1],[-2,2],[-2,3],[-3,0],[-3,1],[-3,2],[-3,3],[-3,4]]
    .filter(([q, r]) => map[q + ',' + r] !== undefined);
  for (const [q, r] of pocket) setStone(B, map, q, r, 0);

  const rH1 = AI.createEngine({ size: 13, playerCount: pc }).think(
    { size: 13, playerCount: pc, turn: 1, board: Array.from(B), out: [false,false,false,false], passes: 0, seen: [] },
    { budgetMs: Math.max(TIME_MS, 1000), seed: 1 }
  );
  console.log('H1) 10-pt pocket inside 2-eye P2 wall (no dame), deep budget. P1 -> ' + rH1.move + ' (playouts=' + rH1.playouts + ')');
  checkProbe('Probe H1: never invades <15pt pocket inside 2-eye living enemy wall', rH1.move === -1, 'move=' + rH1.move);

  const B2 = B.slice();
  for (const [q, r] of pocket.slice(5)) setStone(B2, map, q, r, 2);
  setStone(B2, map, -2, 0, 1);
  const rH2a = AI.createEngine({ size: 13, playerCount: pc }).think(
    { size: 13, playerCount: pc, turn: 1, board: Array.from(B2), out: [false,false,false,false], passes: 0, seen: [] },
    { budgetMs: TIME_MS, seed: 1 }
  );
  const rH2b = AI.createEngine({ size: 13, playerCount: pc }).think(
    { size: 13, playerCount: pc, turn: 2, board: Array.from(B2), out: [false,false,false,false], passes: 0, seen: [] },
    { budgetMs: TIME_MS, seed: 1 }
  );
  console.log('H2) 1 smart-dead P1 stone inside 5-pt P2 2-eye pocket. P1 -> ' + rH2a.move + ', P2 -> ' + rH2b.move);
  checkProbe('Probe H2: neither side wastes moves on already-smart-dead stones', rH2a.move === -1 && rH2b.move === -1, 'P1=' + rH2a.move + ' P2=' + rH2b.move);

  const B3 = B.slice();
  setStone(B3, map, -2, 0, 1);
  const rH3 = AI.createEngine({ size: 13, playerCount: pc }).think(
    { size: 13, playerCount: pc, turn: 1, board: Array.from(B3), out: [false,false,false,false], passes: 0, seen: [] },
    { budgetMs: TIME_MS, seed: 1 }
  );
  console.log('H3) 1 trapped 0-eye P1 stone inside 10-pt P2 2-eye pocket. P1 -> ' + rH3.move);
  checkProbe('Probe H3: does not pile more dead stones onto trapped stone in 2-eye pocket', rH3.move === -1, 'move=' + rH3.move);

  // I1: No prisoners in HEXAGO — P2 has a 4-stone already-smart-dead group IN ATARI (rootCap=4!)
  // inside P1's 2-eye territory. Capturing it gains 0 pts and opens an empty cavity! P1 must PASS!
  const BI = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) { const [q] = g.P[i]; BI[i] = q >= 0 ? 1 : (q <= -4 ? 2 : 3); }
  setStone(BI, map, 5, -4, 0); setStone(BI, map, 4, 1, 0);     // P1 2 real eyes (far from P2 dead group)
  setStone(BI, map, -2, -1, 0); setStone(BI, map, -2, 3, 0);   // P3 2 interior eyes (q in {-1,-2,-3})
  setStone(BI, map, -5, 1, 0); setStone(BI, map, -5, 4, 0);    // P2 2 eyes (q<=-4)
  // 4-stone P2 dead group inside P1's territory (q>=1), with ONLY 1 liberty (1,-1) -> capturing removes 4 stones!
  setStone(BI, map, 2, -1, 2); setStone(BI, map, 2, 0, 2); setStone(BI, map, 3, -1, 2); setStone(BI, map, 3, -2, 2);
  setStone(BI, map, 1, -1, 0);
  for (const style of ['solid', 'balanced', 'aggressive']) {
    const rI1 = AI.createEngine({ size: 13, playerCount: pc, style }).think(
      { size: 13, playerCount: pc, turn: 1, board: Array.from(BI), out: [false,false,false,false], passes: 0, seen: [] },
      { budgetMs: TIME_MS, seed: 1 }
    );
    checkProbe('Probe I1 [' + style + ']: does not capture already-dead 4-stone group in own 2-eye territory (no prisoners)', rI1.move === -1, 'move=' + rI1.move);
  }

  // I2: 3rd-party dead stone in atari inside P2's 2-eye territory -> P1 must NEVER capture and die
  const BI2 = B.slice();
  for (const [q, r] of pocket) setStone(BI2, map, q, r, 2);
  setStone(BI2, map, -2, 0, 3); setStone(BI2, map, -2, 1, 0);
  for (const style of ['solid', 'balanced', 'aggressive']) {
    const rI2 = AI.createEngine({ size: 13, playerCount: pc, style }).think(
      { size: 13, playerCount: pc, turn: 1, board: Array.from(BI2), out: [false,false,false,false], passes: 0, seen: [] },
      { budgetMs: TIME_MS, seed: 1 }
    );
    checkProbe('Probe I2 [' + style + ']: never captures 3rd-party dead stone to die immediately', rI2.move === -1, 'move=' + rI2.move);
  }

  // J1: Sealed own territory of 12 pts (single own region, cAlive===0!) + enemy 2-eye 10-pt
  // territory, 0 dame, passes=0. Must PASS immediately (never self-fill to carve 2 eyes).
  const BJ1 = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const [q, r] = g.P[i];
    if (q >= 5 && !(q === 5 && r <= -4)) BJ1[i] = 0;  // 12-pt P1 single own territory (cAlive===0)
    else if (q >= 0) BJ1[i] = 1;                       // P1 wall
    else BJ1[i] = 2;                                   // P2 wall
  }
  setStone(BJ1, map, -2, -2, 0); setStone(BJ1, map, -2, 3, 0); // P2 2 eyes so P1 has no wall attack
  for (const [q, r] of [[-5,1],[-5,2],[-5,3],[-5,4],[-6,2],[-6,3],[-6,4],[-6,5]]) setStone(BJ1, map, q, r, 0); // 8-pt P2 pocket
  const j1P1Sz = Array.from(BJ1).filter((v, idx) => v === 0 && g.P[idx][0] >= 5).length;
  for (const style of ['solid', 'balanced', 'aggressive']) {
    const rJ1 = AI.createEngine({ size: 13, playerCount: 2, style }).think(
      { size: 13, playerCount: 2, turn: 1, board: Array.from(BJ1), out: [false,false,false], passes: 0, seen: [] },
      { budgetMs: TIME_MS, seed: 1 }
    );
    checkProbe('Probe J1 [' + style + ']: never self-fills safe ' + j1P1Sz + '-pt own territory (single region)', rJ1.move === -1, 'move=' + rJ1.move);
  }

  // J2: All other players already passed (passEnds=true), P1 has huge 28-pt own territory & leads -> instant PASS!
  const BJ2 = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const [q] = g.P[i];
    if (q >= 3) BJ2[i] = 0;          // large P1 own territory
    else if (q >= 0) BJ2[i] = 1;     // P1 wall
    else if (q >= -3) BJ2[i] = 2;    // P2 wall
    else BJ2[i] = 0;                 // P2 territory (smaller)
  }
  for (const style of ['solid', 'balanced', 'aggressive']) {
    const rJ2 = AI.createEngine({ size: 13, playerCount: 2, style }).think(
      { size: 13, playerCount: 2, turn: 1, board: Array.from(BJ2), out: [false,false,false], passes: 1, seen: [] },
      { budgetMs: TIME_MS, seed: 1 }
    );
    checkProbe('Probe J2 [' + style + ']: instant pass when opponent already passed and we lead (large own territory)', rJ2.move === -1 && rJ2.playouts === 0, 'move=' + rJ2.move + ' playouts=' + rJ2.playouts);
  }

  // J3: 3P game where P1 already passed (passes=1), 0 dame left, P2 has large 27-pt own territory
  // while P1 & P3 have 2-eye walls -> P2 must PASS (never self-fill large own territory)!
  const BJ3 = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const [q, r] = g.P[i];
    if (q >= 3) BJ3[i] = 0;           // P2 large own territory (~27 pts)
    else if (q >= 1) BJ3[i] = 2;      // P2 wall
    else BJ3[i] = r <= 0 ? 1 : 3;     // P1 & P3 solid walls
  }
  setStone(BJ3, map, -2, -2, 0); setStone(BJ3, map, -4, -1, 0); // P1 2 eyes
  setStone(BJ3, map, -2, 3, 0);  setStone(BJ3, map, -4, 4, 0);  // P3 2 eyes
  for (const style of ['solid', 'balanced', 'aggressive']) {
    const rJ3 = AI.createEngine({ size: 13, playerCount: 3, style }).think(
      { size: 13, playerCount: 3, turn: 2, board: Array.from(BJ3), out: [false,false,false,false], passes: 1, seen: [] },
      { budgetMs: TIME_MS, seed: 1 }
    );
    checkProbe('Probe J3 [' + style + ']: 3P passes=1 never self-fills large own territory', rJ3.move === -1, 'move=' + rJ3.move);
  }
}

if (ASSERT && failures > 0) {
  console.error('\nPROBE ASSERTIONS FAILED: ' + failures);
  process.exit(1);
}
