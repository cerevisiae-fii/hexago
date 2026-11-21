# HEXAGO MCTS engine — implementation notes (v2.0.0, hex tactics + global candidates + endgame/pass)

Files:
- `dev/ai-engine.js` — the engine (single self-contained file, inlined into `index.html` by `dev/inline-engine.js`)
- `dev/engine-selftest.js` — `node dev/engine-selftest.js` (correctness + throughput), `--strength` adds self-play games
- `dev/engine-notes.md` — this file

Built and measured with Node v26.12.1 (`node`), single thread. No dependencies, no DOM, no
network, no `eval`, no `</script>`, no `require()` / `document.` / `window.` (all asserted by the
self-test). It runs both from Node (`module.exports`) and as a worker script
(`self.HexagoAI`), verified via `new Function("self", src)` exactly like the page fallback path.

## 1. Measured numbers (this machine, 8 cores, single-threaded engine)

Throughput, `engine.think(..., {maxPlayouts: N})` after JIT warm-up (real playout count / wall time):

| board | points | playouts/sec |
|---|---|---|
| 9 | 61 | **6 289** (mid-game position; v1.2 dead-stone cleanup cost ~4.5 %) |
| 13 | 127 | 1 760 |
| 19 | 271 | 548 |
| 25 | 469 | 205 |

AMAF/RAVE overhead is negligible in practice: on a fixed 61-point position, a fresh 150 ms
search performs 956 playouts/call (frozen v1.0.0: 954); at 800 ms 5 011 vs 5 091 (-1.6 %).

Target was ≥ 3 000 playouts/sec on 61 points: **met with ~2.2× margin**.
At the page budgets (500–6500 ms) that is roughly: 61 pts → 3 000–35 000 playouts,
19 pts → 1 000–3 700, 25 pts → 400–1 300.

Strength (self-test `--strength`, page-rules referee, 61 points, 2 players, 2 games, strong seat alternated):

```
game 1: strong seat 1 -> strong wins  scores={strong:61, weak:0}   moves=113 illegal=0
game 2: strong seat 2 -> strong wins  scores={strong:59, weak:1}   moves=112 illegal=0
summary: 300ms 2W / 50ms 0W / 0D, illegal=0, crashes=0
```

Earlier independent bench (Lead, `bench/`): **10/10 wins vs the legacy `aiChoose` at 250 ms/move,
no illegal moves**. A 3-player 120-move self-play game is also validated move-by-move against the
page `sim()` in the self-test.

Self-test result: `node dev/engine-selftest.js` → **ALL PASS: 47 passed, 0 failed**
(`--strength` → 48 passed).

## 2. Rules fidelity

The self-test does not re-implement the rules: it **extracts the reference functions from
`index.html` at runtime** (`build`, `hash`, `group`, `libCount`, `sim`, `territoryForBoard`,
`hexDist`, `DIRS`) and compares:

- geometry/index order (`P`, `NB`, center, `hexDist`) for sizes 9/13/19/25;
- `hashBoard()` vs page `hash()` on random boards (Array + Int8Array, all sizes);
- root legal-move set vs page `sim()` on random positions (2–6 players), plus targeted
  atari-capture / suicide / occupied / superko (capture result already in `state.seen`) cases;
- `scoreBoard` (territory + stones) vs page `territoryForBoard` + stone count, 2–6 players, sizes 9/13/19;
- pass/endgame behaviour, budget compliance, “always a legal move”, `state.board` never mutated;
- seeded determinism and tree-reuse legality.

Root legality is **exact** page legality: occupied / suicide / superko only when a capture happens
(and only against `state.seen`). Deeper tree nodes and playouts use simple ko, as allowed by the spec.

## 3. Algorithm summary

- UCT/MCTS with AMAF/RAVE (v1.1.0), one node per position, time-budgeted (`budgetMs`, default 2500) or capped by
  `maxPlayouts`. `maxPlayouts` takes precedence over wall clock → deterministic with `seed`.
- Each node stores `{n, w, v}` from the perspective of the **parent's mover** (the player who made
  the move leading into the node). UCT at a node therefore maximises that node's mover's outcome;
  backprop uses the terminal score array per player, so 3–6 player games stay adversarial
  (win = rank 1, tie = 0.5, value = (score[p] − best other) / n clamped to [−1, 1]).
- Dead-stone endgame scoring (v1.2.0): every rollout terminal position and every
  pass-end tree terminal is run through an exact port of the page `detectDeadStones()`
  before area scoring (no eyes, liberties <= 2, each liberty surrounded by one enemy
  colour with <= 1 friendly stone, one adjacent enemy colour). The self-test compares
  the removed set 1:1 against the function extracted from `index.html` (crafted + 80
  random boards). This makes the playout/endgame evaluation agree with the page's
  final scoring (which removes dead stones in `finishScore`), instead of scoring dead
  stones as alive. Cost: ~4.5 % throughput (6 588 -> 6 289 pps on 61 points).
- RAVE/AMAF: each child also keeps `rn` (AMAF visits) and `rw` (AMAF wins, same perspective as
  `w`). AMAF counts moves played by the parent's mover anywhere in the simulation (tree moves +
  playout moves, with player attribution). Selection value is
  `(1-β)·Q_uct + β·Q_amaf + c·sqrt(ln N / n)` with the MoGo weight
  `β = rn / (rn + n + 4·n·rn·b²)`, `b = 0.05`. This is a large win at small budgets and decays to
  plain UCT as visit counts grow. Only ~26 lines of the hot path; no API change.
- Tree reuse: a stored root child whose board/turn/passes/out match the new state is adopted as
  the new root; its descendants are kept and its root stats are recomputed from its children so
  all invariants (including `rootMoves`) stay exact.
- Heuristic playouts (light, optimized):
  capture enemy groups in atari > save own groups in atari > random local move, with
  eye-filling avoidance, suicide/self-atari rejection (unless capturing), simple-ko avoidance,
  locality (moves adjacent to stones; tactical analysis around the last two moves).
  Full tactical scan on 61/127-point boards; sampled local scan on 271/469-point boards for speed.
  Playouts end after all active players pass or after `2n+30` turns; terminal score is then
  territory + stones (dead stones scored alive = standard area-scoring approximation).
- Pass: legal everywhere internally; at the **root** it is only offered as a candidate when
  someone already passed, when passing would end the game, or in the endgame (empty ≤ 20 %).
  This avoids an AI that passes with an open board (which area scoring would otherwise evaluate
  as an instant draw). If passing is genuinely best, `move: -1` is returned.
- Resign (`move: -2`) only when `options.resignThreshold` is supplied, 2 players, root visits
  ≥ 256, less than 55 % empty points, and root winrate below the threshold.
- Failure safety: if the time budget is exhausted before any expansion (or `maxPlayouts: 0`),
  a heuristic-ordered legal move is returned; the result is never an illegal placement.

## 4. Public API (exact spec names + additive extras)

Spec-required (unchanged):

```js
geometry(size) -> { size, side, n, P, NB, center, dist(i,j) }
createEngine({ size, playerCount }) -> engine
engine.think(state, options) -> result
hashBoard(board) -> number      // byte-identical to index.html hash()
version                          // "hexago-mcts/1.0.0"
```

`state = { size?, board, turn, playerCount, out, passes, seen }` — `think` never mutates it
(`size` is accepted but not required; it is validated through the board length/geometry).
`options = { budgetMs?, maxPlayouts?, seed?, resignThreshold?, onProgress? }`
(`onProgress({visits, playouts, elapsedMs, bestMove})` every 256 iterations when provided).

`result = { move, visits, playouts, winrate, value, bestMoves, rootMoves, elapsedMs, engine }`:

- `move`: board index, `-1` pass, `-2` resign.
- `visits`: root node visit count (may exceed `playouts` after tree reuse).
- `playouts`: iterations performed in this call.
- `winrate` / `value`: root mover perspective.
- `bestMoves`: top 8 expanded root children, `{move, visits, value}` (root perspective).
- **`rootMoves` (additive, for root-parallel search)**: every expanded root child with
  `visits > 0`, as `{move, visits, winrate, value}`, all from the **root mover perspective**.
  These are mergeable across workers: sum `visits` and `visits*winrate`. For a fresh root
  (and for a reused root) `sum(rootMoves[].visits) === visits`, so
  `Σ visits ≤ visits` always holds. Payload is at most one entry per legal move (≤ n).
- `elapsedMs`, `engine` (build tag string).

Additive debug/testing extras (not required by the page, used by `dev/engine-selftest.js`):

```js
exports._internals.sizeFromN(n)
exports._internals.rootLegalMoves(state)   // exact page-legal list incl. -1 pass
exports._internals.scoreBoard(board, pc)   // territory + stones
engine._rootLegalMoves(state)              // same, reusing the engine's buffers
engine._scoreBoard(board, pc)
engine.size, engine.n
```

`maxPlayouts` precedence: if `maxPlayouts` is a non-negative integer, the search runs exactly that
many iterations and **ignores the wall clock** (this is the determinism contract). Otherwise the
`budgetMs` wall-clock budget is used (default 2500 ms), checked every 8 iterations.

## 5. Known limitations

- Single-threaded: `think()` is synchronous; parallelism is the caller's job (the page worker +
  `rootMoves` merging). No internal async/worker support.
- Playout policy on 19/25 boards analyses tactics only around the last two moves plus a small
  sample (speed trade-off); on 9/13 boards it analyses every local candidate.
- Superko is exact at the root only. Deeper tree nodes and playouts use simple ko (per spec).
- Dead stones ARE now cleaned up at playout/tree terminal positions (v1.2.0, page
  `detectDeadStones` semantics). It is still a heuristic port, and the page's *manual*
  dead-stone confirmation phase is not modelled (all-AI games use the same automatic
  detection, so the two agree).
- Tree reuse only happens when the exact resulting board, turn, pass count and resignation flags
  match a stored root child; otherwise the search restarts. `state.seen` is not stored in the
  engine, so an externally reverted board may simply miss reuse (never incorrect).
- Resignation is opt-in via `resignThreshold`; by default the engine never resigns
  (returns a legal move). The page integration currently does not pass `resignThreshold`.
- Multi-player MCTS is per-seat adversarial (each node maximises its own mover's rank-1 chance);
  it does not model coalitions, and ties are valued as 0.5.
- Not attacked: policy priors, neural evaluation, parallel tree (page does root-parallel merge).

## 6. RAVE experiment and adoption (v1.1.0)

Equal-budget self-play, 61-point board, 2 players, page-rules referee, seats alternated,
distinct seeds, frozen v1.0.0 vs RAVE candidate, 0 illegal moves / 0 crashes in all games:

| budget | games | frozen | RAVE | RAVE winrate |
|---|---|---|---|---|
| 150 ms | 30 | 0 W | **30 W** | **100 %** (adopted) |
| 800 ms | 5 | 3 W | 2 W | 40 % (small sample, ±noise) |

Adoption criterion from the Lead (>= 60 % at the specified 150–300 ms budget, no illegal/crash)
was met with 30/30. The 800 ms single-thread sample is a caveat: RAVE's influence decays to a few
percent by ~1 000 visits/child (`β` formula above), so at high budgets it should behave like plain
UCT; the 5-game 800 ms sample is too small to settle whether the residual ~8 % AMAF influence is
slightly negative. Browser root-parallel per-worker budgets (~120 ms slices, ~1 k visits/worker)
are in the range where RAVE measured clearly stronger.

A depth-limited variant (AMAF updates only in the top 8 plies, version tag `1.1.1-depthrave`)
was also tested at 800 ms: 1 W / 2 L — no better, and it was not adopted.

Build history: v1.0.0 (frozen md5 `5d5e611e6f7728ee0243248af855e8e3`) → v1.1.0 RAVE
(md5 `ebf377fd3c5261d9b3de59c95f7ffa4b`, adopted after the 30–0 equal-budget match above).
v1.0.0 is not shipped; the comparison numbers above are kept as the record of the experiment.
- `dev/ai-engine.js` must be re-inlined (`node dev/inline-engine.js`) after any edit; the page
  copy is the shipped source of truth.


## 7. Pass / dead-stone endgame work (v1.2.0)

Motivation (user report + Lead probe): the engine filled the board to a few empties before
passing and its playout terminal scoring counted dead stones as alive, so its endgame
evaluation disagreed with the page's final scoring (`detectDeadStones` + `finishScore`).

Adopted: an exact port of page `detectDeadStones()` (no eyes, liberties <= 2, every liberty
surrounded by one enemy colour with <= 1 friendly stone, one adjacent enemy colour) is applied
to every rollout terminal position and every pass-end tree terminal before area scoring.
Self-test compares the removed set 1:1 with the function extracted from `index.html`
(crafted case + 80 random boards, sizes 9/13) and checks the crafted dead stone is removed
before scoring. Cost: 61-point throughput 6 588 -> ~6 300-6 500 playouts/sec (-1..4.5 %).

Equal-budget A/B (page-rules referee from `bench/lib/rules.js`, page scoring with dead-stone
removal, 2p, 61 points, seats alternated, distinct seeds, 20 games, 150 ms/move,
0 illegal / 0 crashes):

| engine | wins | notes |
|---|---|---|
| v1.1.0 (frozen) | 8 | raw-vs-page score delta up to 11 pts |
| v1.2.0 (dead-stone cleanup) | **12 (60 %)** | adopted (bar was >= 60 %) |

Dead-stone frequency in those 20 games: 15/20 games had dead stones (avg 1.45 per game),
which is exactly the gap the engine was previously ignoring. Game length unchanged
(~90-120 real moves; raw pass-end score now agrees with the page).

Pass experiment (NOT adopted): "always offer pass + require it to clearly beat the best
placement and only play it when empty <= 55 %" measured 50 % in 4 self-play games (neutral),
with longer games and an occasional earlier pass. The safer gate (pass offered after an
opponent pass, at pass-end, or when empty <= 20 %) was kept. In the adopted build the first
pass happens around move ~100-120 and passes appear at 7-12 then 4-6 empties, i.e. endgame only.

800 ms spot check: not completed inside the timebox (2 games at 800 ms with the 400-move
referee cap ran longer than the remaining budget and were killed); the 150 ms A/B is the
adopted evidence. Rollback if ever needed: check out the previous engine from git history (`git log -- dev/ai-engine.js`) and re-run `node dev/inline-engine.js`.

Build md5: `ff454c5f850943dab3536a0574dde7c5` (v1.2.0).


## 9. AI v3 (experimental, v3.0.0-exp) — explicit opening framework policy, contact penalty, throughput work

Status: **NOT frozen** — the opening behaviour targets are met but the strength targets
(>=55% vs v1.2 at 150/800/1500 ms) are NOT met, so v3 must not replace v2/v1.2 blindly.
Public API unchanged; engine options added for A/B presets (see below).

### Implemented
1. **Explicit opening framework policy** (only with a wall-clock budget, never with
   `maxPlayouts`; only when there is no capture/save/atari urgency). For the first few
   stones (board has <= 9 stones on 9x9, <= 12 on larger boards) the move is chosen
   directly from precomputed framework points with seeded softmax variety:
   - per-size framework score (`geometry().fwScore`): centre / distance-2,3 star
     analogues + 3-3/3-4 corner analogues - edge penalty;
   - candidates must be at distance 2-4 from own stones, must not hug own stones,
     no immediate contact for the first few stones, must be safe (>=2 liberties);
   - top-6 by score, softmax (T=12) seeded pick -> variety (self-test: >=3 distinct
     first moves over 8 seeds, 6-ply spread test).
2. **Midgame contact penalty**: an own-adjacent move with no capture/save/connection/
   cut purpose is penalised by ADJ_PENALTY=420 at the root when unclaimed framework
   points exist. (Measured: it costs strength, see the trade-off table.)
3. **Throughput work** (same behaviour, less cost): precomputed direction-mask pattern
   tables (patternScore is now a table lookup), single-pass group scan for "save"
   detection instead of per-candidate group scans, allocation-light `buildUntried`
   (engine scratch buckets + one array per node, mask-table bucketing), progressive
   global candidates (8/4/2 at 1-2/3-4/5-6 plies).
4. PUCT with pattern/opening priors was implemented and measured: it was clearly
   weaker (c=1.5: 0-32; c=0.15: 43.8%, n=32), so it is off by default (`puctC:0`);
   ordering priors only.
5. Endgame/pass/eye/territory fixes from v2 are retained (own-eye fills 0%).

### Throughput (61-point midgame position, fresh engine, single thread, idle machine)
| budget | v1.2 playouts | v3 playouts | ratio |
|---|---|---|---|
| 150 ms | 1 232 | 1 240 | 1.01x |
| 800 ms | 6 688 | 6 408 | 0.96x |
| 1500 ms | 12 376 | 12 752 | 1.03x |
`node dev/engine-selftest.js` throughput gate: 6 448 playouts/s isolated (gate 4 000).
A 3 751 pps reading was observed while the machine was also running 8 A/B workers; the
fresh single-thread measurements above show v3 has no compute regression vs v1.2.
In-game `playouts/call` is lower (150ms 0.75x, 800ms 0.62x) because the opening policy and
the "nothing useful -> pass" path intentionally return early with 0 playouts; this is an
accounting artefact of the visits metric, not extra CPU time.

### A/B vs v1.2.0 (page-rules referee, seats alternated, distinct seeds, 0 illegal / 0 crashes)
| config | 150 ms | 800 ms | 1500 ms |
|---|---|---|---|
| v3 default (opening policy + contact 420) | **42.2%** (27-37, n=64); with the pre-optimisation build 48.4% (33-31, n=64) -> 45.3% (n=128) | **45.0%** (18-22, n=40) | **40.0%** (8-12, n=20) |
| v3 `{openingStones:3, adjPenalty:0}` (hybrid) | **53.1%** (17-15, n=32) | not measured | not measured |
| v3 `{adjPenalty:0}` (opening only) | 37.5% (12-20, n=32) | - | - |
| v3 `{style:'strength'}` (no opening/penalty) | **56.3%** (18-14, n=32) | - | - |
| v2.0.0 (frozen) vs v1.2 | 60.9% (39-25, n=64) | 55.0% (22-18, n=40, our ref) / bench 41.7% (5-7, n=12) | - |
| v3 default vs v2.0.0 | ~51% (49-47, n=96) | - | - |

### Behaviour vs v1.2.0 (same A/B runs; opening = first 12 plies)
| metric | v1.2 (150/800/1500ms) | v3 default | v3 hybrid (openingStones:3) |
|---|---|---|---|
| opening self-adjacency | 38% / 47% / 53% | **10% / 11% / 13%** | **26%** |
| opening nearest-own distance | 2.12 / 1.94 / 1.79 | **2.45 / 2.43 / 2.42** | **2.20** |
| opening isolated moves | 39% / 35% / 28% | **83% / 81% / 80%** | **53%** |
| midgame self-adjacency | 81% / 82% / 86% | 83% / 85% / 81% | 82% |
| own-eye fills | 4.3% / 3.8% / 3.5% | **0%** | **0%** |
| own-territory fills | 4.9% / 4.7% / 4.7% | **0.5% / 0.3% / 0.7%** | **1.1%** |
| passes / panic passes | 90 / 2 | 76-90 / 2 | 36 / 0 |

Opening targets (nearest-own >= 2.3, opening self-adj <= 35%, first moves not adjacent)
are MET by the default v3 configuration; the midgame self-adjacency target (<= 65%) is
NOT met (both v1.2 and v3 stay around 80-85% in real fights).

### Recommended configurations (createEngine options)
- `{style:'behavior'}` = default: full framework opening + contact penalty. Best opening
  behaviour, ~45% vs v1.2 at 150-1500 ms (strength regression).
- `{openingStones:3, adjPenalty:0}`: hybrid — opening framework for the first ~2 moves
  (opening self-adj 26%, nearest-own 2.20), strength ~53% vs v1.2 at 150 ms. Needs
  800/1500 ms validation before shipping.
- `{style:'strength'}`: no opening policy, no contact penalty — strength ~56% vs v1.2 at
  150 ms, but opening behaviour equals v2 (no user-visible opening change).
Other options: `openingPolicy:false`, `openingStones:N`, `adjPenalty:N`, `puctC:N`.

### Limitations
- Strength/behaviour conflict is real and measured: the explicit framework opening costs
  ~10-15% winrate vs v1.2 at 150 ms; the contact penalty costs a few more. The strength
  preset recovers v2-level strength but gives up the opening behaviour.
- The 1500 ms sample is only 20 games; 800 ms 40 games; treat +/-10-15% as noise.
- In-game "visits/move" is lower than v1.2 because of intentional early returns;
  compute parity is shown by the fresh playout table.
- Build md5: `93100a56d541eb4055c907f6b2302493` (hexago-mcts/3.0.0-exp).
  Rollback: `cp dev/ai-engine-v2.0.0.bak.js dev/ai-engine.js` (v2.0.0 md5
  `016b517867d8745a597809ad3139ae82`) or `dev/ai-engine-v1.2.0.bak.js`.

## 8. AI v2 — hex tactics, global candidates, opening/endgame/multiplayer (v2.0.0)## 8. AI v2 — hex tactics, global candidates, opening/endgame/multiplayer (v2.0.0)

User feedback addressed: the engine only played next to its own stones, did not use hex-specific
two-space-pair tactics, filled its own eyes/territory in the endgame instead of passing, and felt
too steady. Public API (createEngine/think/result/rootMoves) is unchanged.

### What was added

1. **Hex patterns ("HEXAGO is not Go").** A direction mask (6 bits) is computed from a point's
   neighbours and a precomputed `MASK_SCORE[ownMask*64+enMask]` table scores:
   - own **diagonal** two-space pair through the point (TWO shared liberties = miai): +95;
   - own **straight** two-space pair (ONE shared point = cuttable): +58;
   - **cutting** an enemy straight pair (their single shared liberty): +72;
   - peeping one of an enemy diagonal pair's two shared liberties: +42;
   - bamboo/thick multi-connection +26, contact-fight +14, own-eye fill -420.
   Used in root move ordering and tree-expansion ordering; unit-tested for exactly the
   diagonal-vs-straight distinction and the enemy cut vs peep values.
2. **Global / framework candidates.**
   - Root ordering: captures/saves + hex patterns + opening priors (prefers distance 2-4 from the
     nearest stone, centre/star/3-3 analogues, penalises the first line) + seeded jitter for
     variety (self-test: >=3 distinct first moves over 8 seeds).
   - Tree expansion: local moves ordered by mask score **plus up to 8 global candidates**
     (opening anchors + distant empty points), limited to the first 2 plies below each search root
     so the branching factor does not explode at high budgets.
   - Playout: remains the strong v1.2.0 light local policy, but never fills its own eyes
     (passes instead). Mixing global moves into playouts was tested and rejected (see below).
3. **Pass as a first-class decision.**
   - Every root move is classified: capture / save / connection / cut / safe dame / large open
     area / own small territory / own eye / self-atari.
   - If nothing gains anything, the engine immediately passes (no search); in a hopeless settled
     2-player position with `resignThreshold` it resigns (-2); 3+ players never resign.
   - Pass is offered at the root after an opponent pass, when it would end the game, when the
     position is settled, or in the endgame.
   - Own eyes and small own settled territory are never filled (ordering penalty + final selection
     guard). Safe dame is played only when it gains a point. A **large own-bordered open region is
     treated as open**, not as settled territory - this is essential at high budgets (treating it
     as settled made the engine pass/ignore defence and lose whole games; see the A/B history).
4. **Opening variety / temperature.** Seeded jitter in the opening ordering plus framework priors;
   dynamic exploration constant (1.25x UCT_C when behind, 0.9x when ahead) so it fights when behind
   and consolidates when ahead.
5. **Multiplayer.** For 3+ players the node utility blends rank-1 probability with the score margin
   (0.8/0.2) so a seat that cannot win still improves its rank / hurts the leader instead of
   playing randomly. Resignation stays 2-player only.

### Validation (page-rules referee bench/lib/rules.js incl. dead-stone cleanup; 0 illegal, 0 crashes everywhere)

| check | result |
|---|---|
| 150 ms/move, 64 games, v2 vs v1.2.0, seats alternated | **39 W - 25 L = 60.9 %** (target >= 60 %) |
| 800 ms/move, 20 games, v2 vs v1.2.0 | 9 W - 11 L = 45 % (noise; see below) |
| 800 ms/move, 20 more fresh-seed games | 13 W - 7 L = 65 % |
| **800 ms combined (40 games)** | **22 W - 18 L = 55.0 %** (non-regression) |
| bench `--old-vs-new`, 8 games, 150 ms | 8 W - 0 L vs legacy AI, 0 illegal |
| `node dev/engine-selftest.js` | **ALL PASS 67/67** |
| throughput, 61 points | 6 509 playouts/s (target 4 000+; v1.2.0 was 7 396 fresh) |

Behaviour metrics, 150 ms 64-game A/B (v1.2.0 -> v2):

| metric | v1.2.0 | v2.0.0 |
|---|---|---|
| own-eye fills | 3.5 % of placements | **0.0 %** |
| own-settled-territory fills | 5.0 % | **0.9 %** |
| moves into dame/neutral (2+ colours) regions | 81.5 % | **90.6 %** |
| self-adjacent moves | 69.0 % | 74.0 % |
| opening (<=24 moves) avg nearest-stone distance | 1.32 | 1.32 |
| passes / first pass | 75 / ~55 | 83 / ~55 |
| passes with >40 % empty (panic passes) | 1 | 1 |
| avg game length / final empty | 78.6 / 10.9 | 78.6 / 10.9 |

Interpretation: the user-visible endgame problem is fixed (no more own-eye/own-territory filler;
only dame/neutral points are filled). In-game self-adjacency did not fall because the removed
eye/territory fillers were replaced by contact/dame moves; opening framework candidates are present
in root/tree generation and unit-tested (>=3 distinct openers; second move at distance >=2 in 3/6
seeds), but the in-game nearest-stone distance metric is dominated by stones already on the board.

### Rejected experiments (measured, not shipped)

- Always offer pass + "must clearly beat best placement" guard: 50 % (4 games), longer games.
- Mask-driven playout move selection (pick best of N by MASK_SCORE): **9.4 %** (3 W - 29 L, 32 games) -
  playout policy quality matters far more than extra heuristics.
- Stronger opening priors + playout tenuki: 46.9 % (15 W - 17 L, 32 games).
- Global/tenuki candidates in playouts (full v2): 28.1 % (18 W - 46 L, 64 games).
- v2 before the territory/pass correction: 64.1 % at 150 ms but **35 %** at 800 ms (dead groups
  lost after passing while a large own-bordered region was still open). Corrected.
- Conservative-territory intermediate: 57.8 % / 50 %; final thresholds: 60.9 % / 55 %.

### Limitations / trade-offs

- Playout candidate generation is still local (global moves live in root ordering and tree
  expansion). The requirement asked for playouts too, but every variant that mixed them in
  measurably weakened the engine; this is a deliberate strength-first trade-off.
- Throughput is ~12 % below v1.2.0 on a fresh 61-point search (6.5k vs 7.4k playouts/s), still
  well above the 4 000/s requirement; the time budget is respected.
- 800 ms evidence is 40 games (22-18); single batches swing 45-65 %, so the honest read is
  "non-regression, roughly equal at high budget".
- New debug-only exports (`engine._patternScore`, `engine._territoryOwner`) are additive; the
  production API and rootMoves merge semantics are untouched.
- Build md5: `016b517867d8745a597809ad3139ae82` (hexago-mcts/2.0.0).
  Rollback: `cp dev/ai-engine-v1.2.0.bak.js dev/ai-engine.js`.


## 10. Round-2 variant evaluation (v3.1.0-exp) and ship decision

v3-default was rejected (strength regression). The workspace was restored to the frozen
v2.0.0 engine (`dev/ai-engine.js`, md5 `016b517867d8745a597809ad3139ae82`, selftest 67/67).
The experimental build is kept as `dev/ai-engine-v3.1.0-exp.js` (md5
`7b99fdb82074b37ed7171ea45d43af66`; its test suite is `dev/engine-selftest-v3.js`, 71 checks).

Engine options for page-side A/B (all optional, default = v2-compatible behaviour):
`style:'strength'`, `openingPolicy:false`, `openingStones:N`, `adjPenalty:N`,
`softOpening:true`, `softOpeningPlies:N`, `puctC:N`.

Page-rules A/B vs v1.2.0, seats alternated, distinct seeds, 0 illegal / 0 crashes:

| variant (150 ms/move) | winrate | opening self-adj | opening nearest-own | mid self-adj | own-eye/terr fills |
|---|---|---|---|---|---|
| v2.0.0 (frozen, reference) | 60.9% (39-25, n=64) | 38-40% | 2.11-2.14 | 80% | 3-4% / 4-5% |
| v3 default hard opening + ADJ 420 | 45.3% (n=128) | 10-13% | 2.42-2.45 | 81-85% | 0 / 0.3-0.7% |
| A `{openingStones:3, adjPenalty:0}` | 53.1% (17-15, n=32) | 26.0% | 2.20 | 82.4% | 0 / 1.1% |
| B `{openingStones:2, adjPenalty:0}` | not run (timebox) | - | - | - | - |
| C `{softOpening:true, openingPolicy:false, adjPenalty:0}` | **57.8%** (37-27, n=64) | 41.7% | 2.02 | 76.9% | 0 / 1.0% |
| D `{openingPolicy:false, adjPenalty:120}` | **56.3%** (36-28, n=64) | 37.2% | 2.10 | 78.8% | 0 / 0.6% |

800 ms: the A and C runs were started (40 games each) but did not finish inside the
Round-2 timebox, so no 800/1500 ms numbers exist for A-D. 1500 ms not run.

Interpretation: C (soft opening prior) and D (light midgame penalty) recover v2-level
strength and D slightly reduces midgame self-adjacency (80.0% -> 78.8%), but **neither
changes the actual opening spacing** (opening self-adj ~37-42%, nearest-own ~2.0) - the
search overrides the soft prior. Only the hard-opening variants (v3 default, A) improve
opening spacing, and they cost strength.

Recommendation: **keep frozen v2.0.0 as the ship build** (best measured strength at
150 ms; page compute increase compensates elsewhere). If the page wants visible opening
improvement, variant A is the candidate page toggle, but it needs 800 ms validation
(and its 150 ms sample is only n=32, 53.1%).

## 11. AI v2.1 — static gain policy, exact pass gate, attack ordering, lighter compute (v2.1.0)

User report addressed: the shipped engine crouched defensively at the edges, never
attacked, invaded with stones that were 100% dead, and filled every point of its own
settled territory (keeping only two eyes) until the game dragged on far past the point
where the score could move. Under area scoring those fills are exactly 0 points, so the
correct play is to pass once nothing can change the score.

### Root causes found (probes in `dev/probe-behavior.js`, all reproduced at 300 ms and 3000 ms)

1. `classifyRootMoves` marked every point inside a region larger than `TERR_SMALL`
   (12% of the board) as "useful" - on a 13-board any territory over 15 pts was fair
   game for self-filling. Probe A (57-pt own territory): v2.0.0 played inside its own
   territory; probe E: it filled its own 26-pt territory **while dame was still
   available**.
2. The page integration (`js/ai/pool.js`) **overrode the engine's pass decision**: on
   `move === -1` it fell back to the legacy 1-ply `aiChoose()`, which happily placed
   another stone. The engine could never actually pass in the real app - only in the
   bench (which calls `think()` directly). This alone explains most of the "fills
   everything, game never ends" experience at full page budgets.
3. No attack candidates: a 2-3-liberty enemy group was never pressured (probe C: a
   5-stone 2-lib chain closed in a pocket was ignored at every budget; the playout
   only reacts at 1 liberty).
4. Dead invasions: any single-colour enemy region counted as "useful to invade"
   regardless of size or support (probe D: unsupported invasion of a walled 34-pt strip).

### What v2.1.0 does

- **Static gain** (`staticGainFor` + pass-now baseline S0 with conservative dead-stone
  cleanup): every root move is scored by the exact area-score delta it produces.
  Dame = +1, captures = exact, own-territory/eye fills = 0, dead invasions = 0.
  Gain orders the root and drives the pass gate; the final-selection guards exclude
  0-gain fills and doomed invasions from ever being returned while a better child
  exists. (A hard root-candidate restriction was measured too: it guarantees the
  behaviour directly and speeds up big-board search ~1.3-2x playouts/s, but it costs
  strength at high budgets - 37.5% vs 62.5% against frozen v2.0.0 at 800 ms on the
  61-point board - so it ships as opt-in `createEngine({ restrictCand: true })`.)
- **Invasion viability**: an invasion of a solid enemy territory is only offered when
  the region can plausably hold life: region >= V_MIN with own support within 3, or
  region >= V_DEEP (30% of the board) for unsupported deep invasions, and always when
  it captures or attacks a <=3-lib group. Everything else is scored exactly 0.
- **Exact pass gate**: pass if and only if no own move has gain and no opponent can
  move the score either (no dame left, no own region is viably invadable, no own
  weak group). Passing then returns instantly with zero playouts - the endgame no
  longer consumes the time budget at all. The old "pass after an opponent pass"
  justification is gone: dame are taken first.
- **Attack ordering + certain-kill bias**: root ordering adds a liberty-pressure bonus
  on enemy groups with <=3 libs and <2 eyes (scaled by group size, x1.25 when the
  target is the score leader in 3+ players, x0.7 for the last player). A *certain
  kill* (their other liberty fully enclosed, our stone safe) gets a bonus worth the
  whole capture plus a progressive selection bias, because playout noise on sparse
  boards otherwise hides N-stone captures (probe C was invisible to plain UCT at any
  budget). Two further attack channels were measured and rejected as defaults
  (exactly like every earlier playout experiment in section 10): giving playouts a
  0.35-probability 2-lib enemy pressure, and adding weak-group liberties to tree
  expansion - both cost strength at equal budget (18.8% -> 45.3% when removed) and
  are now opt-in via `createEngine({ playoutAtk: true })` / `{ treeAtk: true }`.
- **Multiplayer / size adaptation**: opening centre weight drops and corner/edge
  frameworks get a bonus with 3+ players (space race); self-atari rejection rises to
  0.99 with 4+ players; opening anchors scale with board radius (3/4/5-line corner
  analogues for 13/19/25); V_MIN/V_DEEP scale with board area.
- **Lighter compute (page)**: budget 12 s/15 s -> 2.5/3/4/6 s by board size, worker
  cap 8 -> 4, engine pass honoured as final. The exact pass gate makes the endgame
  return with 0 playouts, so the wall-clock saving is largest exactly where the old
  engine burned most of its budget.

### Bugs fixed along the way

- `rootLibs` was clamped to 2 by the early-exit group scan, so every ">=3 libs"
  viability test was dead code. Root legality now computes exact liberties.
- `viable` in the classification loop was not reset per move (stale value leaked from
  the previous candidate, which is why dead invasions kept appearing).
- `nearestOwnWithin(..., 4)` never checked distance 4 (rings only go to 3).
- Regions bordered by two *other* players were misclassified as invasions, blocking
  legitimate dame fills in multiplayer neutral strips (now: invasion = single-enemy-
  colour region only).

### Validation

- `node dev/engine-selftest.js` -> **ALL PASS 68/68** (65 inherited checks updated for
  the new policy: an 8-pt own pocket is now *correctly* passed as frozen; a 54-pt
  own-bordered open area is still defended, never treated as settled).
- `dev/probe-behavior.js` (new, kept as a tool): A no own-fill, C captures the closed
  pocket chain at 300 ms and 3000 ms, D only takes dame (no dead invasions, passes
  when frozen), E takes dame before anything else.
- Browser regression `node dev/cdp/regress.js` -> **34/34 PASS** with the new
  `js/ai/pool.js` (pass honoured, budgets, workers).
- Throughput (self-test, fresh engine): 61 pts ~9.0k pps, 127 pts ~2.6k pps,
  271 pts ~1.1k pps, 469 pts ~0.49k pps (v2.0.0: 6.3k/1.8k/0.55k/0.21k - the
  gain-ordered root visits stronger moves earlier, which speeds the same
  playout loop 1.4-2.4x even with full candidate freedom).
- A/B vs frozen v2.0.0 (`bench/test/engines/hexago-mcts-2.0.0.js`), page-rules
  referee, seats alternated, 0 illegal / 0 crashes: see the numbers below.

| match | result |
|---|---|
| 2P 9-board, 150 ms/move, shipped build (4 seeds, n=64) | **51.6%** (33-31) - non-regression |
| 2P 9-board, 800 ms/move, shipped build (n=16) | 37.5% (6-10; 45.8% pooled with the identical-variant run, n=24 - statistically parity within noise, needs a bigger sample to settle) |
| 3P 13-board, 300 ms/move, shipped build (n=8 games / 24 seats) | **4-4 equal** (primary configuration), illegal 0 |

- Behaviour (3P 13-board self-play, 60 ms/move, new bench classification metrics):
  v2.0.0 baseline was avg 237 moves/game with ~1/3 of its invasions doomed and passes
  while dame remained. Shipped v2.1.0: **175 moves (-26%)**, own-region fills 0, eye fills 0,
  invasions 26 of which 5 flagged by the bench doomed-proxy, every game fully settled
  at the end (~2 post-settlement moves), passes only after the dame is gone.

Build md5: `dd666b57db434707e175dd84c15ebb83` (`hexago-mcts/2.1.0`). Rollback: `git checkout` the previous
`dev/ai-engine.js` + `js/ai/engine.js` + `js/ai/pool.js` and re-run
`node dev/sync-engine.js`. The gain policy can also be disabled for A/B with
`createEngine({ gainPolicy: false })`; other A/B switches: `restrictCand`,
`atkOrder`, `playoutAtk` (default off), `treeAtk` (default off).

### A/B strength history (all vs frozen v2.0.0, page-rules referee, 0 illegal / 0 crashes)

| config | 2P 9-board 150 ms | 2P 9-board 800 ms | 3P 13-board 300 ms |
|---|---|---|---|
| v2.1.0 with playoutAtk+treeAtk ON (initial defaults) | **18.8%** (12-52, n=64) | - | - |
| ablation: same with playoutAtk OFF | 37.5% (n=16) | - | - |
| ablation: same with treeAtk OFF | 25% (n=16) | - | - |
| ablation: legacy classification + playoutAtk+treeAtk ON | 12.5% (n=16) | - | - |
| v2.1.0 + candidate restriction ON (V_DEEP fixed) | 50.0% (16-16, n=32) | 25-37.5% (n=24) | **4-4 (equal)**, n=12 games |
| restriction OFF + doomed-invasion guard (**shipped**) | **51.6%** (33-31, n=64, 4 seeds) | 37.5% (6-10, n=16; 45.8% pooled n=24 - parity within noise) | **4-4 (equal)**, n=8 games / 24 seats |

The shipped default keeps full search freedom (restriction OFF) because the
restriction's strength cost grows with budget (50% at 150 ms but 25-37.5% at
800 ms, while restriction-off measured 62.5% at 800 ms); behaviour is instead
guaranteed by the final-selection guards (own-eye/own-territory fill redirect,
doomed-invasion redirect) plus the exact pass gate.

Behaviour (3P 13-board self-play, 60 ms/move, new bench classification): avg game
length **178 moves vs 237** for frozen v2.0.0 at the same budget/seed; own-region
fills 1.7% (v2.0.0 fills whenever a region exceeds 12% of the board); eye fills 0;
doomed invasions down to ~1/3 of v2.0.0's rate; every game fully settled at the end
(post-settlement filler ~2 moves); passes now happen only after the dame is gone
(the old build passed with 41% of the board still open).

## 12. AI v2.2 — strength-first re-goal, true-rules referee, tuning sweep (v2.2.0)

User correction: lightness was only ever a stepping stone - **the goal is maximum
strength, even if slower**.  pool.js budgets restored to 12 s / 15 s with up to
8 workers (the pass-honouring fix and the instant endgame pass stay: those are
correctness, not lightness).  The measurable target became "beats the shipped
v2.0.0 decisively" at the reference budget (150 ms/move, n>=64).

### The referee was lying (and so was the engine's terminal eval)

The bench referee scored pass-end games with the **conservative**
`detectDeadStones()`, but the page's actual pass-end scorer is
**`detectDeadStonesSmart()`** (region-enclosed no-two-eye groups get an
alternating-enemy capture search).  Fixed on both sides:

- `bench/lib/rules.js` now implements the page's smart scorer (regionInfo +
  playStoneOnBoard + canEnemyCaptureGroup + detectDeadStonesSmart), and
  `finishByPass` scores with it.  `bench/lib/old-ai.js` extracts the page's
  smart function (plus playStoneOnBoard / canEnemyCaptureGroup) and the
  cross-check now verifies BOTH dead-stone detectors 1:1 against the page.
- The engine gained the same port (`removeDeadStonesSmart`, opt-in
  `createEngine({ smartDead: true })`) with `dev/smart-parity.js` verifying it
  against the page's function on crafted + 120 random positions (2-6 players,
  all sizes).  Two real bugs were found by that parity harness before shipping:
  the dead-list collection read a scratch buffer clobbered by the sim's own
  group scans (wrong stones removed), and the capture sim iterated liberties in
  a different order than the page's group() discovery (order-sensitive: which
  liberty is filled first can decide suicide vs capture).  After the fixes the
  port is 1:1.

### What the measurements said (all vs frozen v2.0.0, 150 ms/move, smart referee)

| config | winrate | note |
|---|---|---|
| shipped v2.1.0 (bias floor 0.35) | 51.6% (conservative referee era) | baseline then |
| v2.1 + certain-kill floor removed | **71.9%** (n=32, conservative referee) | the floor starved strategic moves |
| v2.1 + floor removed + smart terminal eval + smart referee | 48.4% (n=64) | see below |
| same, engine smart-eval OFF (conservative playouts) | **56.3%** (n=32) | smart eval hurts search |
| + UCT_C 1.1 -> 0.95 | **71.9%** (n=32) | lower exploration wins |
| + playout save probability 0.85 -> 0.92 | 65.6% (n=32) | rescue atari more often |
| smart referee alone changes the game: all numbers after this section are smart-referee | - | old numbers not comparable |

Three lessons:
1. **Accurate terminal scoring made the search WEAKER.**  The per-terminal
   capture search removes large dead-ish groups from every playout outcome,
   adding score variance that is uncorrelated with the root move; the
   conservative eval is a smoother search prior.  The engine therefore ships
   with conservative playout-eval by default (`smartDead` opt-in); the REFEREE
   stays smart because that is the truth of the real game.
2. **The certain-kill bias floor was quietly toxic** (-16% under the smart
   referee).  Root selection over-commits visits to tactical kills and starves
   strategic moves - this was also the "attacks too much" feel.  The decaying
   head start (to zero) stays; the permanent floor is gone.
3. **Static guards must yield to deep search verdicts.**  Redirecting the final
   choice away from a static-±0-looking move (own-fill / doomed invasion)
   costs -25% at 800 ms when the search has actually PROVEN the move good
   (56.3% with the guards off vs 31% with them on, n=16).  The guards now apply
   only below GUARD_MIN_VISITS = 16000 root visits: 150 ms reaches ~4k (guards
   on, behaviour guaranteed), 800 ms reaches ~26k (deep verdicts trusted).

### Final configuration (v2.2.0)

- conservative terminal eval (default), smart available via `smartDead`
- certain-kill bias decays to zero (no floor)
- no invasion ordering bonus (gain already prices invasions)
- UCT_C = 1.1 (unchanged: the 0.95 sweep result did not survive n=64),
  playout save probability 0.92 (the measured +12.5 points)
- pool.js: 12 s / 15 s budgets, up to 8 workers (strength-first)

### Validation (v2.2.0 checkpoint)

| match | result |
|---|---|
| 2P 9-board, 150 ms/move (6 seeds, n=96, smart ref) | 57.3% (55-41), illegal 0 |
| 2P 9-board, 800 ms/move (n=16, smart ref) | 62.5% (10-6), illegal 0 |
| 3P 13-board, 300 ms/move (n=16 games, smart ref) | A 37.5% (9-15) vs B 29.2% (7-17), illegal 0 |

v2.2.0 had two remaining flaws found in the 3P 13-board logs: (1) eye fills
reappeared (65 moves, 3.3%) because `countStabAt` flagged 2-eye living groups
(which have 2 liberties) as weak and endgame searches exceeded `GUARD_MIN_VISITS`,
bypassing the eye guard; (2) opening stones still scattered widely (mean
`nearestOwn` 4.3 on 13-board) and 13-board throughput (~2.6k pps) left the root
best move with only ~12 visits at 300 ms.

## 13. AI v3.0 — O(1) incremental chains, deeper tree search, coherent openings (v3.0.0)

### Root causes & architecture upgrades

1. **O(1) incremental pseudo-liberty chains in playouts** (`playInitChains`,
   `checkPlayMove`, `playCommit`): replaces per-ply full-board `scanGroup` flood
   fills with circular-linked chains tracking `(cLibCnt, cLibSum, cLibSq)` in
   exact integer arithmetic (Float64). Exact atari test is O(1) via Cauchy-Schwarz
   (`cLibCnt * cLibSq === cLibSum * cLibSum`, unique liberty `cLibSum / cLibCnt`).
   Suicide, capture, and self-atari are all checked non-mutating in O(degree <= 6).
   Verified 1:1 against `bench/lib/rules.js` across 360 random games / 61,744
   moves (2..6 players, sizes 9 & 13) with 0 mismatches.
2. **Playout bugfixes & local sharpness**:
   - Captured intersections are now restored to `empList` (`addEmpty`), enabling
     recaptures, ko fights, and throw-ins during rollouts.
   - `plyPasses` now resets to 0 on every placement (previously non-consecutive
     passes could terminate rollouts early).
   - Incremental `atariList` + last-move local atari/hex-pattern response +
     LGRF-1 (Last Good Reply with Forgetting).
   - First-play AMAF rule (`if (amafMark[e] !== amafStamp)`) and `histCapEnd[histLen]`
     undo index fix.
3. **Unconditional eye-fill & 2-eye living-group fix**:
   - `countStabAt` skips own groups that already have `>= 2` eyes.
   - Pure non-capture own eyes are excluded from root candidates unconditionally
     (so neither single-worker search nor 8-worker `pool.js` merging can ever fill
     an eye) and guarded unconditionally at final selection.
   - Small uninvadable own-territory pockets (`terrSize < V_MIN`) are also guarded
     unconditionally; larger invadable own territories still trust deep search.
4. **Deeper MCTS search & coherent opening framework**:
   - Internal expansion threshold (`EXPAND_THRESH = 3`) + internal progressive
     widening (`PW_K0 = 8, PW_K1 = 2.5`) + tuned `UCT_C = 0.70`, `RAVE_B = 0.04`,
     and 2P score-margin tiebreaker (`MARGIN_2P = 0.04`).
   - Soft virtual root priors (`rootPriorN/W`, kept separate from exact visit
     counts `ch.n`) from captures/saves/hex-patterns and player-count-adaptive
     opening coherence: rewards dist 2-3 from own stones, penalizes 1st-line edge
     clinging and isolated dist >= 5 scattering near opponents (especially in 3P+).
   - Multi-ply tree reuse (up to `min(activeCount, 4)` plies) so tree reuse
     actually fires across opponent turns in real 2P..6P games.

### Throughput (Node v26.13.1, pure zero-dependency JS)

| board | v2.0.0 | v2.2.0 | **v3.0.0** | speedup vs v2.0.0 |
|---|---:|---:|---:|---:|
| 9-board (61 pts) | 6,300 pps | 8,993 pps | **19,688 pps** | **3.1x** |
| 13-board (127 pts) | 1,800 pps | 2,552 pps | **10,020 pps** | **5.6x** |
| 19-board (271 pts) | 550 pps | 1,057 pps | **4,684 pps** | **8.5x** |
| 25-board (469 pts) | 210 pps | 491 pps | **2,690 pps** | **12.8x** |

### Final validation (v3.0.0 vs frozen v2.0.0, smart referee, 0 illegal / 0 crashes)

| benchmark | result | behaviour highlights |
|---|---|---|
| 2P 9-board, 150 ms/move (4 seeds, n=64) | **93.8%** (60W-4L-0D) | eyeFills **0**, ownRegionFills **0**, doomedInvasions **0** |
| 2P 9-board, 800 ms/move (2 seeds, n=16) | **93.8%** (15W-1L-0D) | eyeFills **0**, illegal **0** |
| 3P 13-board, 300 ms/move (16 games / 48 seats) | **16-0 in games** (A seat 66.7% 16W-8L vs B 0.0% 0W-24L) | A: eye **0**, own **0**, doomed **3.3%** (vs B 9.8%), openNearestOwn **2.7** (vs B 4.5), openCentre **2.9** (vs B 4.2) |
| 3P 13-board self-play, 150 ms/move (n=4) | avg **208.8** moves, **4/4 settled** | eye **0**, own 1, postSettleOwn **0**, illegal **0** |
| 4P 13-board self-play, 100 ms/move (n=2) | avg **293.0** moves, **2/2 settled** | eye **0**, own **0**, illegal **0** |
| `dev/engine-selftest.js` | **68/68 PASS** | — |
| `dev/smart-parity.js 40` | **42/42 PASS** | 1:1 page `detectDeadStonesSmart` parity |
| `dev/probe-behavior.js --time 300 --assert` | **ALL PASS** (A/B/E/F/G1-G3) | 2-eye group never fills eye; 3P13 opening meanNearestOwn 3.14, isolated(>=6) 11.1%, 1st-line 0.0% |

Ablation notes (Stage 2 vs Stage 1 at 150 ms n=24: `UCT_C=0.70` 83.3% > `0.45` 75.0% > `0.25` 70.8%; 3P13 @300 ms x12: Stage 2 beat Stage 1 11-1 in games while cutting doomed invasions 85 -> 39 and opening `nearestOwn` 3.8 -> 2.6).

Build md5: `af69b2bd7bc5b87fa10a6b609ccb70f7` (`hexago-mcts/3.0.0`).
