'use strict';
/**
 * MOCK engine -- NOT the real HEXAGO engine.
 *
 * Purpose: exercise bench.js wiring (--old-vs-new / --new-vs-new / --probe,
 * engine verification, per-move stats, JSON output) before/independently of
 * dev/ai-engine.js.
 *
 *   node bench/bench.js --probe --engine bench/test/mock-engine.js
 *   node bench/bench.js --old-vs-new --games 4 --time 50 --engine bench/test/mock-engine.js
 *   node bench/bench.js --new-vs-new --games 3 --time 20 --time2 50 --engine bench/test/mock-engine.js
 *
 * It implements the dev/ENGINE_SPEC.md module surface but only picks a fast
 * greedy capture move -- it is not a measure of the real engine's strength.
 */
const path = require('path');
const rules = require(path.join(__dirname, '..', 'lib', 'rules.js'));

function geometry(size) { return rules.geometry(size); }
function hashBoard(board) { return rules.hash(board); }

function createEngine(cfg) {
  const R = rules.createRules(cfg.size);
  return {
    think: function (state, options) {
      const o = options || {};
      const st = {
        board: state.board.slice(),
        turn: state.turn,
        playerCount: state.playerCount,
        out: state.out.slice(),
        passes: state.passes,
        seen: state.seen.slice(),
        seenSet: new Set(state.seen),
      };
      const budget = o.budgetMs == null ? 2500 : o.budgetMs;
      const rng = rules.makeRng(o.seed || 1);
      const t0 = Date.now();
      const legal = R.legalMoves(st);
      const candidates = legal.concat([-1]);
      let bestMove = -1, bestScore = -Infinity, visits = 0, playouts = 0;
      const bestMoves = [];
      for (let k = 0; k < candidates.length; k++) {
        if (visits > 0 && Date.now() - t0 >= budget) break;
        const mv = candidates[k];
        let score = 0;
        if (mv !== -1) {
          const r = R.simMove(st.board, mv, st.turn, st.seenSet);
          if (!r) continue;
          score = 1 + r.cap.length * 100 + rng() * 3;
          playouts++;
        }
        visits++;
        if (score > bestScore) { bestScore = score; bestMove = mv; }
        bestMoves.push({ move: mv, visits: 1, value: 0 });
      }
      bestMoves.sort(function (a, b) { return b.visits - a.visits; });
      return {
        move: bestMove,
        visits: visits,
        playouts: playouts,
        winrate: 0.5,
        value: 0,
        bestMoves: bestMoves.slice(0, 8),
        elapsedMs: Date.now() - t0,
        engine: 'mock-1',
      };
    },
  };
}

module.exports = { geometry: geometry, createEngine: createEngine, hashBoard: hashBoard, version: 'mock-1' };
