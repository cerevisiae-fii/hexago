# HEXAGO AI engine spec (v1)

Goal: replace the current 1-ply heuristic AI in `index.html` with a much stronger
search engine (MCTS-based), integrated as an inline Web Worker.

This spec is the contract between:

- engine implementation file: `dev/ai-engine.js` (self-contained, no DOM)
- benchmark harness: `bench/` (Node)
- Lead integration into `index.html` (inline `<script id="ai-engine-src" type="text/plain">`)

Nothing in `dev/` or `bench/` ships in the page; the final page embeds the engine
source verbatim. `index.html` is written ONLY by the Lead.

---

## 1. Game rules (must match `index.html` exactly)

Board: hexagonal, axial coords, radius `R = SIDE - 1`, `SIDE = (size + 1) / 2`
for `size ∈ {9, 13, 19, 25}` → points = `3*SIDE*(SIDE-1)+1` → 61, 127, 271, 469.

Index order (identical to page `build(n)`):

```js
for (let r = -(SIDE-1); r < SIDE; r++)
  for (let q = -(SIDE-1); q < SIDE; q++)
    if (Math.abs(q + r) <= SIDE - 1) { M[q+','+r] = P.length; P.push([q, r]); }
NB = P.map(([q,r]) => DIRS.map(([a,b]) => M[(q+a)+','+(r+b)]).filter(v => v !== undefined));
const DIRS = [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
```

Colors/players: `1..playerCount` (2–6). `state.out[p] === true` means the player
resigned; they never move again, but their stones stay on the board and still
count in scoring. `state.turn` is who moves now.

Move legality = page `sim()`:

1. occupied cell → illegal
2. place stone, then remove every adjacent enemy group with 0 liberties
   (captures are accumulated)
3. if own group now has 0 liberties → suicide, illegal
4. if a capture happened AND `hash(resultingBoard)` is already in the position
   hash list `state.seen` → superko, illegal (note: page only applies this check
   when `cap.length > 0`)

`hash` is cyrb53 over the board array (copy exactly, see `index.html`):

```js
function hash(a) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 2654435761); h2 = Math.imul(h2 ^ a[i], 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
```

Pass: `state.passes` counts consecutive passes (page resets it on a real move).
When `passes >= activePlayers` (`activePlayers` = non-`out` players) the game ends
and is scored.

Scoring (page `territory()` + `finishScore()`): `score[p] = territory[p] + stones[p]`,
where territory = empty regions whose border colors are exactly `{p}`; captures
(`damage[]`) do NOT score. Winner = highest score (ties possible). During playouts,
dead stones are scored as alive (standard area scoring approximation).

---

## 2. Engine public API (`dev/ai-engine.js`)

Must run in Node (require) and in a Worker (`self`). No DOM, no network, no
external dependencies, no `eval`. Plain ES2017-compatible JS (no optional
chaining needed, but fine). File must be a single self-contained file.

```js
// UMD-ish attach:
// Node: module.exports = { geometry, createEngine, hashBoard, version }
// Worker/browser: self.HexagoAI = {...}

geometry(size) -> {
  size, side, n, P /* [[q,r],...] */, NB /* [[i,...],...] */,
  center /* index of (0,0) */, dist(i,j) /* hex distance */
}

createEngine({ size, playerCount }) -> engine  // caches geometry per size

engine.think(state, options) -> result
// state: {
//   board: number[] | Int8Array,   // length n, 0 empty, 1..playerCount stone
//   turn: number,
//   playerCount: number,
//   out: boolean[],                // index 0 unused
//   passes: number,
//   seen: number[],                // position hashes already played (superko source)
// }
// options: {
//   budgetMs: number,              // wall-clock search budget, default 2500
//   maxPlayouts: number,           // optional hard cap (bench)
//   seed: number,                  // optional deterministic PRNG seed
//   resignThreshold: number,       // optional, e.g. 0.02
//   onProgress?: fn(stats)         // optional (ignored in worker)
// }
// result: {
//   move: number,                  // board index, or -1 = pass, -2 = resign
//   visits: number,
//   playouts: number,
//   winrate: number,               // root mover perspective, 0..1
//   value: number,                 // -1..1
//   bestMoves: [{move, visits, value}],
//   elapsedMs: number,
//   engine: string                 // version/build tag for debugging
// }

hashBoard(board) -> number        // MUST equal page hash()
```

`think` must not mutate `state` or `state.board`. It may keep caches/tree between
calls on the same engine instance (tree reuse is a plus, but correctness first).

---

## 3. Strength requirements (what "strong" means here)

- Search must look many plies ahead via playouts/tree, not a fixed 1–2 ply score.
- Required features (in priority order):
  1. **MCTS/UCT** with a growing tree and fair budget usage (iterative until time
     is up; always return a legal best move).
  2. **Decent playout policy** — not uniform random: capture groups in atari,
     save own groups in atari, avoid filling own eyes, avoid suicide/self-atari
     unless it captures, bias toward moves near the last move / existing stones.
     This matters more than tree tweaks at small budgets.
  3. **Multi-player handling (2–6 players)**: each node is evaluated from the
     perspective of the player who moves there; terminal score array is mapped
     per-player to `score[p] - max(score[other active players])` (clamped), so
     every seat plays adversarially for itself/rank, not as a coalition.
  4. **Tree reuse** between moves where the current state is reachable from the
     stored tree (optional if clean).
  5. **Ko/superko legality** at the root exactly as the page; playouts only need
     simple ko (do not recreate the immediately previous position).
  6. **Pass handling**: pass is a legal root move/child; pass returns -1 when it
     is genuinely best (e.g. no useful move), and playouts end after all active
     players pass.
  7. **Resign** (optional, only 2-player, late game, winrate < threshold) → -2;
     otherwise never resign.
- Speed target: ≥ 3000 playouts/sec on the 61-point board in Node on this
  machine (8-core). Report measured throughput. Avoid per-move allocations on
  the hot path (reuse typed arrays, incremental play/undo).
- Determinism: with the same `seed` + `maxPlayouts`, same result.

---

## 4. Bench harness (`bench/`)

`bench/bench.js` CLI (Node, no deps):

```
node bench/bench.js --old-vs-random --games 20 --size 9 --players 2
node bench/bench.js --old-vs-new --games 20 --size 9 --players 2 --time 300
node bench/bench.js --new-vs-new --games 10 --size 9 --time 100 --time2 800
```

- Implements the full game rules above in Node (independent of the page).
- Extracts the OLD AI (`aiChoose`) plus its helper functions from `index.html`
  at runtime (regex/slice between the `// ===== AI` marker and
  `const aiSeatOf`) and runs it in a sandbox with `G/P/NB/M/SIDE/seenSet`
  provided. Sanity check: old AI vs random must finish many games with 0 illegal
  moves / crashes (an illegal old-AI move counts as a loss, reported separately).
- Loads `dev/ai-engine.js` via `require` for the new engine.
- Match runner: alternate first player, report W/L/D, average score margin,
  average ms/move, illegal moves, crashes. JSON output option `--json`.
- Also implement `--probe` mode: run the new engine on a few hand-built
  positions and assert returned move is legal, plus print `bestMoves`.

---

## 5. Reporting (teammates → Lead)

Report back: files written, exact commands run + output summary, measured
strength numbers, known limitations, and any API changes from this spec.
Do NOT edit `index.html`.
