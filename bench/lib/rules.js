'use strict';
/**
 * HEXAGO game rules -- independent Node implementation.
 *
 * Mirrors the page (index.html) exactly:
 *   - hex board, axial coords, index order of `build(n)`
 *   - capture Go rules, suicide is illegal
 *   - superko checked ONLY when a capture happened (page `sim`)
 *   - pass ends the game after all *active* (non-resigned) players pass
 *   - resignation removes a player from the rotation; their stones still score
 *   - area scoring: score = territory + stones (captures are NOT scored)
 *   - end-of-game dead-stone cleanup (page `detectDeadStones` + `finishScore`)
 *
 * No DOM, no dependencies.
 */

const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const VALID_SIZES = [9, 13, 19, 25];

/**
 * Board geometry, identical to the page `build(n)` / DIRS / NB construction.
 * size 9/13/19/25 -> side 5/7/10/13 -> n 61/127/271/469 points.
 */
function geometry(size) {
  if (!VALID_SIZES.includes(size)) throw new Error('invalid board size: ' + size + ' (expected 9|13|19|25)');
  const side = (size + 1) / 2;
  const P = [];
  const M = Object.create(null);
  for (let r = -(side - 1); r < side; r++) {
    for (let q = -(side - 1); q < side; q++) {
      if (Math.abs(q + r) <= side - 1) { M[q + ',' + r] = P.length; P.push([q, r]); }
    }
  }
  const NB = P.map(function (qr) {
    const q = qr[0], r = qr[1];
    return DIRS.map(function (d) { return M[(q + d[0]) + ',' + (r + d[1])]; })
      .filter(function (v) { return v !== undefined; });
  });
  const center = M['0,0'];
  function dist(i, j) {
    const dq = P[i][0] - P[j][0], dr = P[i][1] - P[j][1];
    return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
  }
  return { size: size, side: side, n: P.length, P: P, NB: NB, M: M, center: center, dist: dist };
}

/** cyrb53 over the board array -- byte-identical to page `hash(a)`. */
function hash(a) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 2654435761);
    h2 = Math.imul(h2 ^ a[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** mulberry32 deterministic PRNG. */
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap deterministic seed mixing for per-game / per-move streams. */
function mixSeed(seed, a, b, c) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ ((a >>> 0) + 0x85ebca6b), 0xc2b2ae35);
  h = Math.imul(h ^ ((b >>> 0) + 0x27d4eb2f), 0x165667b1);
  h = Math.imul(h ^ ((c >>> 0) + 0x9e3779b9), 0x27d4eb2f);
  h = (h ^ (h >>> 15)) >>> 0;
  return h || 1;
}

/** Build the rules facade for one board size. */
function createRules(size) {
  const geo = geometry(size);
  const P = geo.P, NB = geo.NB, n = geo.n;

  function newState(playerCount) {
    if (!(playerCount >= 2 && playerCount <= 6)) throw new Error('playerCount must be 2..6');
    return {
      size: size,
      playerCount: playerCount,
      board: new Array(n).fill(0),
      turn: 1,
      out: new Array(playerCount + 1).fill(false), // out[0] unused
      passes: 0,
      seen: [],          // hashes of every position that has occurred (page G.seen)
      seenSet: new Set(), // fast lookup of the above
      dead: [],
      last: -1,
      moves: 0,
      over: false,
      phase: 'playing',
    };
  }

  /** Stones of the same colour connected to i (page `group`). */
  function groupOf(board, i) {
    const c = board[i];
    if (!c) return [];
    const seen = new Set([i]);
    const q = [i];
    while (q.length) {
      const x = q.pop();
      const nbs = NB[x];
      for (let k = 0; k < nbs.length; k++) {
        const nb = nbs[k];
        if (board[nb] === c && !seen.has(nb)) { seen.add(nb); q.push(nb); }
      }
    }
    return Array.from(seen);
  }

  /** Liberty count of a group (page `libCount`). */
  function libCount(board, grp) {
    const s = new Set();
    for (let k = 0; k < grp.length; k++) {
      const nbs = NB[grp[k]];
      for (let j = 0; j < nbs.length; j++) if (!board[nbs[j]]) s.add(nbs[j]);
    }
    return s.size;
  }

  /** Page `sim`: returns {a, cap} or null when illegal. */
  function simMove(board, i, p, seenSet) {
    if (board[i]) return null;
    const a = board.slice();
    a[i] = p;
    const cap = [];
    const done = new Set();
    const nbs = NB[i];
    for (let k = 0; k < nbs.length; k++) {
      const nb = nbs[k];
      if (a[nb] && a[nb] !== p && !done.has(nb)) {
        const g = groupOf(a, nb);
        for (let j = 0; j < g.length; j++) done.add(g[j]);
        if (!libCount(a, g)) for (let j = 0; j < g.length; j++) cap.push(g[j]);
      }
    }
    for (let k = 0; k < cap.length; k++) a[cap[k]] = 0;
    if (!libCount(a, groupOf(a, i))) return null;            // suicide
    if (cap.length && seenSet && seenSet.has(hash(a))) return null; // superko (only on capture)
    return { a: a, cap: cap };
  }

  /** Current player (state.turn) move test; does not mutate state. */
  function tryMove(state, i) {
    if (!Number.isInteger(i) || i < 0 || i >= n) return null;
    return simMove(state.board, i, state.turn, state.seenSet);
  }

  /** All legal board moves for the current player (pass omitted). */
  function legalMoves(state) {
    const out = [];
    const p = state.turn;
    for (let i = 0; i < n; i++) if (!state.board[i] && simMove(state.board, i, p, state.seenSet)) out.push(i);
    return out;
  }

  /** Advance to the next non-resigned player (page `nextTurn`). */
  function nextTurn(state) {
    let t = state.turn;
    const count = state.playerCount;
    let guard = 0;
    do { t = t % count + 1; guard++; } while (state.out[t] && guard <= count);
    state.turn = t;
  }

  function activeCount(state) {
    let c = 0;
    for (let p = 1; p <= state.playerCount; p++) if (!state.out[p]) c++;
    return c;
  }

  /** Page `play(i)`: returns the capture result or null when illegal. */
  function applyMove(state, i) {
    const r = tryMove(state, i);
    if (!r) return null;
    state.board = r.a;
    state.last = i;
    state.passes = 0;
    const h = hash(state.board);
    state.seen.push(h);
    state.seenSet.add(h);
    state.moves++;
    nextTurn(state);
    return r;
  }

  /** Page `doPass`: returns true when the game must now be scored. */
  function doPass(state) {
    state.passes++;
    state.last = -1;
    state.moves++;
    if (state.passes >= activeCount(state)) { state.phase = 'dead'; return true; }
    nextTurn(state);
    return false;
  }

  /** Page `resign`: returns {over, winners?, reason?}. */
  function resign(state) {
    const p = state.turn;
    state.out[p] = true;
    state.moves++;
    state.passes = 0;
    const active = activeCount(state);
    if (active <= 1) {
      state.over = true;
      state.phase = 'ended';
      const winners = [];
      for (let q = 1; q <= state.playerCount; q++) if (!state.out[q]) winners.push(q);
      return { over: true, winners: winners, resigned: p };
    }
    nextTurn(state);
    return { over: false, resigned: p };
  }

  /** Page `territory()`: empty regions bordered by exactly one colour. */
  function territoryOf(board, playerCount) {
    const t = new Array(playerCount + 1).fill(0);
    const vis = new Set();
    for (let i = 0; i < n; i++) {
      if (board[i] || vis.has(i)) continue;
      const reg = [i];
      const cols = new Set();
      vis.add(i);
      for (let k = 0; k < reg.length; k++) {
        const nbs = NB[reg[k]];
        for (let j = 0; j < nbs.length; j++) {
          const nb = nbs[j];
          if (!board[nb]) { if (!vis.has(nb)) { vis.add(nb); reg.push(nb); } }
          else cols.add(board[nb]);
        }
      }
      if (cols.size === 1) t[Array.from(cols)[0]] += reg.length;
    }
    return t;
  }

  /** Page `countEyes(b, g, color)` (hex: all 6 neighbours of an empty point are own stones). */
  function countEyes(board, grp, color) {
    const own = new Set(grp);
    const eyes = new Set();
    for (let k = 0; k < grp.length; k++) {
      const nbs = NB[grp[k]];
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j];
        if (board[nb] || eyes.has(nb)) continue;
        const around = NB[nb];
        if (around.length >= 3 && around.every(function (x) { return board[x] === color || own.has(x); })) eyes.add(nb);
      }
    }
    return eyes.size;
  }

  /** Page `detectDeadStones()`: conservative automatic dead-stone estimate at pass end. */
  function detectDeadStones(state) {
    const b = state.board;
    const seen = new Set();
    const dead = [];
    for (let i = 0; i < b.length; i++) {
      if (!b[i] || seen.has(i)) continue;
      const color = b[i];
      const g = groupOf(b, i);
      for (let k = 0; k < g.length; k++) seen.add(g[k]);
      const libs = new Set();
      for (let k = 0; k < g.length; k++) {
        const nbs = NB[g[k]];
        for (let j = 0; j < nbs.length; j++) if (!b[nbs[j]]) libs.add(nbs[j]);
      }
      const eyes = countEyes(b, g, color);
      if (eyes > 0 || libs.size > 2 || libs.size === 0) continue;
      const libArr = Array.from(libs);
      const surrounded = libArr.every(function (lib) {
        let around = 0, friendly = 0;
        const nbs = NB[lib];
        for (let j = 0; j < nbs.length; j++) {
          if (b[nbs[j]] && b[nbs[j]] !== color) around++;
          if (b[nbs[j]] === color) friendly++;
        }
        return around >= Math.max(2, nbs.length - 2) && friendly <= 1;
      });
      const enemyColors = new Set();
      for (let k = 0; k < g.length; k++) {
        const nbs = NB[g[k]];
        for (let j = 0; j < nbs.length; j++) if (b[nbs[j]] && b[nbs[j]] !== color) enemyColors.add(b[nbs[j]]);
      }
      if (surrounded && enemyColors.size === 1) dead.push.apply(dead, g);
    }
    return Array.from(new Set(dead));
  }

  /**
   * Area score (page `finishScore` core). removeDead=true applies `state.dead`
   * first (page behaviour at pass end). Returns score, territory, stones and
   * the ranking among non-resigned players.
   */
  function scoreState(state, opts) {
    if (opts && opts.removeDead) {
      for (let k = 0; k < state.dead.length; k++) {
        const i = state.dead[k];
        if (state.board[i]) state.board[i] = 0;
      }
      state.dead = [];
    }
    const t = territoryOf(state.board, state.playerCount);
    const stones = new Array(state.playerCount + 1).fill(0);
    for (let i = 0; i < n; i++) { const v = state.board[i]; if (v) stones[v]++; }
    const scores = new Array(state.playerCount + 1).fill(0);
    const active = [];
    for (let p = 1; p <= state.playerCount; p++) {
      scores[p] = t[p] + stones[p];
      if (!state.out[p]) active.push(p);
    }
    const ranked = active.slice().sort(function (a, b) { return scores[b] - scores[a]; });
    const topScore = ranked.length ? scores[ranked[0]] : 0;
    const top = ranked.filter(function (p) { return scores[p] === topScore; });
    const secondScore = ranked.length > 1 ? scores[ranked[1]] : null;
    return {
      scores: scores,
      territory: t,
      stones: stones,
      active: active,
      ranked: ranked,
      top: top,
      topScore: topScore,
      secondScore: secondScore,
      margin: secondScore === null ? null : topScore - secondScore,
    };
  }

  /** Page pass end: detect dead stones, remove them, score, end the game. */
  function finishByPass(state) {
    state.dead = detectDeadStones(state);
    const summary = scoreState(state, { removeDead: true });
    state.over = true;
    state.phase = 'ended';
    return summary;
  }

  return {
    geo: geo,
    size: size,
    n: n,
    newState: newState,
    groupOf: groupOf,
    libCount: libCount,
    simMove: simMove,
    tryMove: tryMove,
    legalMoves: legalMoves,
    nextTurn: nextTurn,
    activeCount: activeCount,
    applyMove: applyMove,
    doPass: doPass,
    resign: resign,
    territoryOf: territoryOf,
    countEyes: countEyes,
    detectDeadStones: detectDeadStones,
    scoreState: scoreState,
    finishByPass: finishByPass,
  };
}

module.exports = {
  DIRS: DIRS,
  VALID_SIZES: VALID_SIZES,
  geometry: geometry,
  hash: hash,
  makeRng: makeRng,
  mixSeed: mixSeed,
  createRules: createRules,
};
