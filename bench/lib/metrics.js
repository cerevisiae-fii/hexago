'use strict';
/**
 * Per-move classification helpers for the extended `--style` behaviour metrics.
 *
 * Everything here is engine-agnostic pure board analysis: the only inputs are
 * the rules facade `R` (bench/lib/rules.js), the board *before* the move, the
 * move point, the mover's colour and the `sim` result of the move
 * (`{ a: afterBoard, cap: [captured points] }` from `R.simMove`).
 *
 * Region semantics mirror the page's `regionInfo()` (js/ai/heuristic.js) and
 * `countEyes()` (js/core/rules.js): an empty region is a maximal set of
 * connected empty points; its border colours are the colours of the stones
 * adjacent to the region. Bench never imports page files -- these are compact
 * re-implementations so the harness stays standalone Node.
 *
 * Move classification (one class per board move, computed on the position
 * before the move; passes are not classified):
 *
 *   regionKind  (exclusive, from the border-colour set of the empty region
 *                that contains the played point, ANY size):
 *     'own'      -- region bordered only by the mover's colour
 *                  (own-region fill; eye fills are the subset where all
 *                  neighbours of the point are mover stones)
 *     'invasion'-- region whose border colours are all other players'
 *                  colours (no mover colour on the border)
 *     'dame'    -- everything else: region with no bordering stones at all,
 *                  or a contested region whose border contains the mover's
 *                  colour plus at least one other colour
 *
 *   captureMove    -- the move removed enemy stones (sim.cap.length > 0).
 *   tacticalSave   -- an own group with exactly 1 liberty (atari) before the
 *                    move has >= 2 liberties after it. Own stones can never
 *                    be removed by an own placement, so "still on the board"
 *                    is guaranteed; this covers extension, connecting to a
 *                    friendly group, and capturing the adjacent enemy group
 *                    that held the own group in atari.
 *   attackMove     -- the move captures an enemy group, OR reduces an enemy
 *                    group's liberty count to 1 (atari), OR reduces by >= 1
 *                    the liberties of an enemy group that had <= 3 liberties
 *                    and fewer than two eyes before the move. "Enemy" is any
 *                    colour != mover (multi-player: all other seats, resigned
 *                    seats included -- their stones stay on the board).
 *                    Only enemy groups adjacent to the placed stone can lose
 *                    a liberty, so only those are examined.
 *   defenseMove    -- tacticalSave OR a move whose stone neighbours (if any)
 *                    are all the mover's colour ("adjacent only to own
 *                    stones"; a move with no stone neighbours is NOT
 *                    defense).
 *
 *   doomedInvasion -- invasion into an enemy-only region of size <=
 *                    DOOMED_REGION_MAX with no own stone within hex distance
 *                    DOOMED_SUPPORT_DIST at placement time (proxy for "the
 *                    stone is 100% dead").
 *
 * Settledness (complaint 4, operational definition): the board is "fully
 * settled" iff EVERY empty region is bordered by exactly one colour. The
 * tracker records this after every board move and derives, per game, the
 * first move index at which the board became fully settled and stayed so
 * until the end, plus the board-move count from there on.
 *
 * Hex distance: max(|dq|, |dr|, |dq+dr|) (== R.geo.dist).
 */

// Complaint-2 thresholds for the doomed-invasion proxy.
const DOOMED_REGION_MAX = 10;   // enemy-only region size (points)
const DOOMED_SUPPORT_DIST = 3;  // no own stone within this hex distance

/**
 * Compact page-`regionInfo` equivalent.
 * Returns { id: regionIndexPerPoint, regs: [{points, size, cols:Set}] }.
 * `id[i]` is -1 for stones; the empty region index for empty points.
 */
function regionInfo(R, board) {
  const NB = R.geo.NB;
  const n = R.n;
  const id = new Array(n).fill(-1);
  const regs = [];
  for (let i = 0; i < n; i++) {
    if (board[i] || id[i] >= 0) continue;
    const rid = regs.length;
    const points = [i];
    const cols = new Set();
    id[i] = rid;
    for (let k = 0; k < points.length; k++) {
      const nbs = NB[points[k]];
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j];
        if (board[nb]) { cols.add(board[nb]); continue; }
        if (id[nb] < 0) { id[nb] = rid; points.push(nb); }
      }
    }
    regs.push({ points: points, size: points.length, cols: cols });
  }
  return { id: id, regs: regs };
}

/** Fully settled: every empty region is bordered by exactly one colour. */
function isFullySettled(regs) {
  for (let k = 0; k < regs.length; k++) if (regs[k].cols.size !== 1) return false;
  return true;
}

/** Hex distance to the nearest stone of `color` (null when the colour has none). */
function nearestStoneDistance(R, board, point, color) {
  const P = R.geo.P;
  const q0 = P[point][0], r0 = P[point][1];
  let best = null;
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== color) continue;
    const dq = P[i][0] - q0, dr = P[i][1] - r0;
    const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
    if (best === null || d < best) best = d;
  }
  return best;
}

/** True when the point is an eye of `color` (page-countEyes point semantics). */
function isEyePoint(R, board, point, color) {
  const nbs = R.geo.NB[point];
  if (nbs.length < 3) return false;
  for (let k = 0; k < nbs.length; k++) if (board[nbs[k]] !== color) return false;
  return true;
}

/**
 * Classify one board move. `before` is the position before the move, `sim` the
 * result of R.simMove(before, move, mover, ...) = { a, cap }.
 */
function analyzeMove(R, before, move, mover, sim) {
  const NB = R.geo.NB;
  const after = sim.a;
  const cap = sim.cap || [];
  const captured = cap.length;

  // --- region class of the played point (before placement) ---
  const regions = regionInfo(R, before);
  const reg = regions.regs[regions.id[move]] || null;
  const cols = reg ? reg.cols : new Set();
  const regionSize = reg ? reg.size : 0;
  let regionKind;
  if (cols.size === 1 && cols.has(mover)) regionKind = 'own';
  else if (cols.size >= 1 && !cols.has(mover)) regionKind = 'invasion';
  else regionKind = 'dame'; // no bordering stones, or mover+other colours

  // --- stone adjacency of the played point (before placement) ---
  const nbs = NB[move];
  let adjacentStones = 0, adjacentOwn = 0, adjacentEnemy = 0;
  for (let k = 0; k < nbs.length; k++) {
    const v = before[nbs[k]];
    if (!v) continue;
    adjacentStones++;
    if (v === mover) adjacentOwn++; else adjacentEnemy++;
  }
  const adjacentOwnOnly = adjacentStones > 0 && adjacentEnemy === 0;

  // --- eye fill (subset of own-region fill) ---
  const isEyeFill = isEyePoint(R, before, move, mover);

  // --- doomed-invasion proxy (subset of invasion) ---
  let isDoomedInvasion = false;
  if (regionKind === 'invasion' && regionSize <= DOOMED_REGION_MAX) {
    const d = nearestStoneDistance(R, before, move, mover);
    isDoomedInvasion = d === null || d > DOOMED_SUPPORT_DIST;
  }

  // --- capture ---
  const isCapture = captured > 0;

  // --- attack: enemy groups adjacent to the placed stone (the only groups
  //     that can lose a liberty). A captured group vanishes as a whole. ---
  let attackByCapture = isCapture;
  let attackByAtari = false;
  let attackBySqueeze = false;
  const seenEnemy = new Set();
  for (let k = 0; k < nbs.length; k++) {
    const nb = nbs[k];
    const color = before[nb];
    if (!color || color === mover || seenEnemy.has(nb)) continue;
    const grp = R.groupOf(before, nb);
    for (let j = 0; j < grp.length; j++) seenEnemy.add(grp[j]);
    if (!after[grp[0]]) continue; // whole group captured -> capture clause
    const beforeLibs = R.libCount(before, grp);
    const afterLibs = R.libCount(after, grp);
    if (afterLibs === 1 && beforeLibs > 1) attackByAtari = true;
    else if (beforeLibs <= 3 && afterLibs < beforeLibs && R.countEyes(before, grp, color) < 2) attackBySqueeze = true;
  }
  const isAttack = attackByCapture || attackByAtari || attackBySqueeze;

  // --- tactical save: an own group that was in atari (exactly 1 liberty)
  //     before the move is no longer in atari after it. Own groups can only
  //     gain liberties from the placed stone (when adjacent) or from captured
  //     stones becoming empty (when the captured stones touched the group),
  //     so seeding from the move point and the captured points is exact. ---
  let isTacticalSave = false;
  const seenOwn = new Set();
  function scanOwnSeeds(pt) {
    const around = NB[pt];
    for (let j = 0; j < around.length; j++) {
      const s = around[j];
      if (before[s] !== mover || seenOwn.has(s)) continue;
      const grp = R.groupOf(before, s);
      for (let t = 0; t < grp.length; t++) seenOwn.add(grp[t]);
      if (R.libCount(before, grp) !== 1) continue;      // was not in atari
      const afterGrp = R.groupOf(after, grp[0]);        // may include the new stone + connected own groups
      if (R.libCount(after, afterGrp) >= 2) { isTacticalSave = true; return; }
    }
  }
  scanOwnSeeds(move);
  if (!isTacticalSave && captured) for (let k = 0; k < cap.length; k++) scanOwnSeeds(cap[k]);

  const isDefense = isTacticalSave || adjacentOwnOnly;

  // --- settledness of the resulting position ---
  const settledAfter = isFullySettled(regionInfo(R, after).regs);

  return {
    regionKind: regionKind,
    regionSize: regionSize,
    regionColors: cols.size,
    isOwnRegionFill: regionKind === 'own',
    isEyeFill: isEyeFill,
    isDame: regionKind === 'dame',
    isInvasion: regionKind === 'invasion',
    isDoomedInvasion: isDoomedInvasion,
    capturedStones: captured,
    isCapture: isCapture,
    isTacticalSave: isTacticalSave,
    isAttack: isAttack,
    attackByCapture: attackByCapture,
    attackByAtari: attackByAtari,
    attackBySqueeze: attackBySqueeze,
    adjacentStones: adjacentStones,
    adjacentOwn: adjacentOwn,
    adjacentEnemy: adjacentEnemy,
    adjacentOwnOnly: adjacentOwnOnly,
    isDefense: isDefense,
    settledAfter: settledAfter,
  };
}

module.exports = {
  DOOMED_REGION_MAX: DOOMED_REGION_MAX,
  DOOMED_SUPPORT_DIST: DOOMED_SUPPORT_DIST,
  regionInfo: regionInfo,
  isFullySettled: isFullySettled,
  nearestStoneDistance: nearestStoneDistance,
  isEyePoint: isEyePoint,
  analyzeMove: analyzeMove,
};
