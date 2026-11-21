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
const TIME_MS = +(process.argv[process.argv.indexOf('--time') + 1] || 300);
const AI = require(ENGINE_FILE);

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
}

/* ---------- Probe C: capturable enemy group in a closed pocket ---------- */
// 13-board. A P2 chain sits inside a fully enclosed P1 pocket (wall at hex
// distance 2 around (2,0)); the chain has exactly 2 liberties and no escape.
// Killing it is worth ~+9 (5 stones + pocket). Does P1 capture/attack it?
{
  const pc = 3, { g, map, eng } = mk(13, pc);
  const B = new Int8Array(g.n);
  const ctr = map['2,0'];
  const inner = [ctr, ...g.NB[ctr]];                 // 7 points of the pocket
  // P1 wall = every point at hex distance 2 from (2,0)
  for (let i = 0; i < g.n; i++) if (g.dist(i, ctr) === 2) B[i] = 1;
  // P2 chain: 5 stones inside the pocket, 2 interior points left as liberties
  const chain = inner.slice(0, 5);
  for (const i of chain) B[i] = 2;
  const libs = new Set();
  for (const i of chain) for (const nb of g.NB[i]) if (!B[nb]) libs.add(nb);
  ring(B, map, -1, 0, 3);                            // P3 somewhere neutral
  console.log('C) P2 ' + chain.length + '-stone chain closed in a P1 pocket, ' + libs.size + ' liberties; P1 to move. capture?');
  const res = think({ g, map, eng }, B, 1, pc);
  show(B, g, res.move, 'res.playouts=' + res.playouts);
  const atk = [...libs].map(l => g.P[l].join(',')).join(' ');
  console.log('   (killing points: ' + atk + ')');
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
  console.log('   (dame points should be taken first, then pass)');
}
