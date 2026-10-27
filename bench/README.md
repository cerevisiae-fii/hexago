# HEXAGO benchmark harness (`bench/`)

Node-only strength/tactics benchmark for the HEXAGO AI work. No npm dependencies,
no DOM, no network. Runs on Node v26 (tested v26.12.1).

The harness is self-validating: it re-implements the game rules independently,
then cross-checks that implementation against the page's own
`sim()` / `territory()` / `detectDeadStones()` before any match number is
produced. The OLD AI is **not** copied by hand -- it is sliced out of
`index.html` at runtime and executed in a `vm` sandbox, so the benchmark always
measures the AI that actually ships.

Layout:

```
bench/bench.js             CLI, match runner, aggregation, probe mode
bench/lib/rules.js         independent game rules (geometry, sim, pass, score, resign)
bench/lib/old-ai.js        index.html AI extraction + vm sandbox + cross-check
bench/test/mock-engine.js  mock engine to self-test the bench wiring (NOT the real engine)
bench/README.md            this file
```

Nothing in `bench/` ships in the page; `dev/ai-engine.js` is only `require()`d.

---

## Quick start

```bash
cd hexago

# baseline: page AI vs uniform-random legal player
node bench/bench.js --old-vs-random --games 40 --size 9 --players 2 --seed 1

# page AI vs new engine (dev/ai-engine.js), 200 ms/move
node bench/bench.js --old-vs-new --games 10 --size 9 --players 2 --time 200

# new engine vs itself with two budgets
node bench/bench.js --new-vs-new --games 10 --size 9 --time 100 --time2 800

# legality/bestMoves probe on hand-built positions
node bench/bench.js --probe --size 9 --time 300

# machine-readable (includes every game, diagnostics, engine verification)
node bench/bench.js --old-vs-random --games 40 --seed 1 --json
```

Rough runtimes on this machine (8 cores, Node 26): 40 games of
`--old-vs-random --size 9` take ~10 s; one 13-board game ~2 s; one 19-board game
~15 s (the old AI is O(points) per move, so 25-board games are slow -- use small
`--games`). Default engine-mode runs stay under 5 min: `--old-vs-new` (10 games,
300 ms) ~75 s; `--new-vs-new` (4 games, 100/800 ms) ~3-4 min.

---

## Modes

| Mode | Agent A (odd seats) | Agent B (even seats) |
|---|---|---|
| `--old-vs-random` | OLD AI from `index.html` | uniform random legal player (passes 8%) |
| `--old-vs-new` | OLD AI from `index.html` | `dev/ai-engine.js` with `--time` budget |
| `--new-vs-new` | `dev/ai-engine.js` with `--time` | same engine with `--time2` |
| `--probe` | -- runs the new engine on constructed positions, asserts legality, prints `bestMoves` |

Who moves first is alternated every game: on even game indexes agent A takes
seat 1 (moves first), on odd indexes agent B does. For 3-6 players the two agents
alternate seats; with more than 2 seats the first agent fills odd seats on even
games. Per-game logs record which seat held which agent.

---

## Options

| Option | Default | Meaning |
|---|---|---|
| `--games N` | 10 (4 for `--new-vs-new`) | number of games |
| `--size N` | 9 | board size: 9, 13, 19, 25 -> 61, 127, 271, 469 points |
| `--players N` | 2 | 2..6 players |
| `--time ms` | 300 | new-engine budget, engine A / `--old-vs-new` |
| `--time2 ms` | 800 | new-engine budget, engine B (`--new-vs-new`) |
| `--playouts N` | -- | optional `maxPlayouts` cap for engine A |
| `--playouts2 N` | -- | optional `maxPlayouts` cap for engine B |
| `--seed N` | 1 | deterministic seed (game RNG + old-AI `Math.random` + engine seed) |
| `--json` | off | print one JSON object on stdout (all human output suppressed) |
| `--page PATH` | `hexago/index.html` | alternative page file to extract the old AI from |
| `--engine PATH` | `hexago/dev/ai-engine.js` | alternative engine module (see mock self-test) |
| `--verbose` | off | progress dots on stderr |

Exit codes: `0` ok, `1` usage error, `2` new engine missing/broken (or old-AI
extraction failed), `3` rules cross-check failed / probe failed.

---

## What the harness guarantees before measuring

1. **Rules cross-check.** The independent implementation in
   `bench/lib/rules.js` is compared against the page's own `sim()`,
   `territory()` and `detectDeadStones()` extracted from `index.html`, on 6
   random positions reached by random legal play (2/3/4 players): every
   empty-point move legality, territory arrays, automatic dead-stone sets, and
   `hash()` (cyrb53) vectors. The baseline run prints e.g.
   `OK vs page sim/territory -- 6 positions, 246 move legality, 6 territory, 6 dead-stone, 7 hash vectors`.
   If the page changes and the check fails, the run exits `3` instead of
   silently reporting numbers.
2. **Old-AI extraction.** Two strategies, first one that yields a callable
   `aiChoose` wins:
   - `marker-slices` (spec): slice `// ===== AI` .. `const aiSeatOf`, plus the
     rules block (`// ===== ルール` .. `// ===== AI`), plus any symbol still
     missing located by name (e.g. `hash`, which lives outside both markers);
   - `named-symbols`: brace-matched extraction of every required
     function/const by name, tolerant to marker/comment edits.
   The sandbox supplies `G, P, NB, M, SIDE, seenSet, playerCount` and a seeded
   `Math.random`, and the extracted `aiChoose` is sanity-called on 3 positions:
   it must return `-1` (pass), `-2` (resign) or a legal board index.
3. **New-engine contract.** When `dev/ai-engine.js` exists, `geometry(size)` is
   compared with the reference geometry for all four sizes, `hashBoard()`
   against the page `hash()` on 7 vectors (superko compatibility), and
   `createEngine({size, playerCount})` must return an object with
   `think(state, options)`. `think()` must not mutate the state it is given; the
   runner verifies the input copies after every call and reports mutations.
   Missing `dev/ai-engine.js` is not an error for `--old-vs-random`; the other
   modes exit `2` with a clear message.

---

## Rules implemented (identical to `index.html`)

Hex board of radius `SIDE-1`, `SIDE=(size+1)/2`, index order of the page
`build(n)`; 61/127/271/469 points for 9/13/19/25.

- Move = empty point; place stone, remove adjacent enemy groups with 0
  liberties (captures accumulate); if own group has 0 liberties it is suicide
  and illegal.
- Superko: the resulting position hash is checked **only when a capture
  happened** (page `sim`). Hash is the page cyrb53 over the board array.
- Pass: `passes` counts consecutive passes and resets on a real move; when
  `passes >= activePlayers` (non-resigned) the game ends and is scored exactly
  like the page: conservative `detectDeadStones()` cleanup, then
  `score = territory + stones`, territory = empty regions bordered by exactly
  one colour. Captures (`damage`) are not scored.
- Resignation: the player is marked `out`, keeps their stones, never moves
  again; if only one active player remains the game ends immediately.
- Winner among active players = highest area score; ties are draws.
- During the old AI's own hypothetical evaluation the page's 1-ply logic is
  used unchanged (same extracted code).

The OLD AI may return `-2` (resign) in any player count -- that is page
behaviour (`aiChoose` resign path). The NEW engine only gets `-2` accepted in
2-player games, per `dev/ENGINE_SPEC.md`; `-2` in a 3-6 player game counts as an
illegal engine move.

---

## Metrics

- `per seat` -- W/L/D of seat 1, 2, ... (seat 1 always moves first).
- `per agent` -- W/L/D over all seats that agent occupied (`winrate = W/seats`),
  `avgDiff` = mean of `own score - best other score` (signed, so + is good),
  `ms/move` = wall-clock around `choose()` including engine search,
  `visits/playouts` = mean of the engine's reported counters per move.
- `avg score margin` = mean of `top score - second best score` over games that
  reach scoring (winner - runner-up; 0 for a draw; games forfeited by
  crash/illegal move have no margin).
- `illegal moves` and `crashes` are counted separately per agent; an illegal
  move or an exception ends that game as a forfeit (offender loses, other
  active seats win) and is still counted in the run.
- `max-move truncation`: a safety cap of `8 * points + 200` moves; a game that
  hits it is scored as-is and reported (should be 0 for normal play; the mock
  engine can trigger it in multi-player).
- Everything is deterministic for the RNG side (`--seed`): game choices,
  old-AI jitter, engine seed arguments. A wall-clock-limited engine can still
  vary run to run because its search depends on elapsed time.

---

## Measured baseline (this machine, Node v26.12.1, 8 cores)

| command | games | result | illegal | crashes | elapsed |
|---|---|---|---|---|---|
| `node bench/bench.js --old-vs-random --games 40 --size 9 --players 2 --seed 1` | 40 | OLD AI **40 W / 0 L / 0 D (100%)**, avg margin **55.6**, avg 91.5 moves/game | 0 (old), 0 (random) | 0 / 0 | **9.91 s** (0.25 s/game) |
| `... --old-vs-random --games 3 --size 13 --players 2 --seed 2` | 3 | OLD AI 3 W / 0 L (100%), avg margin 127, 198 moves/game, 19.8 ms/move | 0 | 0 | 6.02 s |
| `... --old-vs-random --games 2 --size 19 --players 2 --seed 3` | 2 | OLD AI 2 W / 0 L (100%), avg margin 205, 376 moves/game, 80.3 ms/move | 0 | 0 | 30.62 s |
| `... --old-vs-random --games 5 --size 9 --players 3 --seed 5` | 5 | OLD AI 5 W / 3 L seat outcomes (62.5%), 1 resignation | 0 | 0 | 1.63 s |
| `... --old-vs-random --games 3 --size 9 --players 4 --seed 6` | 3 | OLD AI 3 W / 3 L seat outcomes (50%), 0 resignations | 0 | 0 | 1.02 s |

First comparisons against `dev/ai-engine.js` (`hexago-mcts/1.0.0`, engine sha256
prefix **4b1f79378392**, measured 2026-10-27 13:37-13:42 JST; see the next section
for interpretation). Every report prints the engine sha256 prefix, because the
engine is under active development:

| command | games | result | illegal | crashes | elapsed |
|---|---|---|---|---|---|
| `node bench/bench.js --probe --size 9 --time 300` | -- | **5/5 positions legal**, 0 input mutations; geometry OK, hashBoard OK (7 vectors vs page hash), createEngine OK | -- | -- | ~3 s |
| `node bench/bench.js --old-vs-new --games 10 --size 9 --players 2 --time 200 --seed 1` | 10 | **new engine 10 W / 0 L (100%)**, OLD AI 0 W / 10 L; avg margin 3.9; old 5.9 ms/move, new 200.5 ms/move (18 068 visits/mv) | 0 / 0 | 0 | 53.5 s |
| `node bench/bench.js --new-vs-new --games 2 --size 9 --players 2 --time 100 --time2 400 --seed 1` | 2 | 1 W / 1 L each (seat 2 won both); avg margin 47.5; A 3 810 visits/mv (~38 k/s), B 35 112 visits/mv (~88 k/s) | 0 / 0 | 0 | 53.1 s |

The random player is very weak on purpose (it plays uniformly, passes 8% of the
time and never resigns), so the old AI captures essentially everything and the
2-player margin saturates near the board area (55.6 of 61 on average; 61 - X
when the old AI takes every point). Use `--old-vs-new`/`--new-vs-new` for real
strength comparisons; `old-vs-random` is the regression baseline that must stay
at 0 illegal moves / 0 crashes.

`--probe` summary for the current engine build (5/5 legal):

```
new engine : hexago-mcts/1.0.0 [4b1f79378392] | geometry OK | hashBoard OK (7 vectors, ref page hash()) | createEngine OK
[1] empty board (opening) (2P): move 21(0,-1) legal=OK visits=2176 playouts=2176 302ms
[3] capture available (atari): move 17(4,-2) legal=OK ... (capture-in-one: chosen=NO)
[4] 3-player midgame (3P): move 6(0,-3) legal=OK visits=2224
[5] 2-player late game: move 51(-3,3) legal=OK visits=3544
probe: 5/5 legal, 0 input mutations => PASS
```

---

## First old-vs-new result -- interpretation

Measured build **4b1f79378392** (39 KB, 2026-10-27 13:37): at the requested
first-comparison budget (`--time 200`) the **new engine beats the page AI 10-0**
on 9x9/2P, but only by 3.9 points on average -- the page AI is tactically tough
(its capture/atari heuristics are strong), so the current engine wins the games
without dominating them. The engine passes every contract check (geometry,
`hashBoard` vs the page hash on 7 vectors, legal moves, no state mutation,
0 crashes / 0 illegal moves) and beats the random player 61-0 in a direct check,
so the harness is feeding it correct states.

Build history matters for this project: the **first** engine build that appeared
during bench development (sha256 prefix `1fec2d5f951e`, 35 KB, 13:28) lost the
same 10-game 200 ms match **0-9-1** (old AI 9 W / 1 D, avg margin 54.9). The
engine was then revised to `4b1f79378392`, which wins 10-0. Conclusion: engine
strength at low budgets is sensitive to the playout policy and root setup, and
benchmark numbers are only meaningful together with the engine file hash -- the
harness records it in `diagnostics.engineFile.sha256` and prints the prefix.
Re-run `--old-vs-new --games 10 --size 9 --players 2 --time 200` after every
engine change; treat `--time 200` as a cheap regression gate, not a strength
ceiling (use `--time 1000`+ or `--playouts` for reported strength).

## Wiring the new engine / self-test without it

`dev/ai-engine.js` does not need to exist for `--old-vs-random`. To validate the
new-engine paths before it lands, run the harness against the mock module:

```bash
node bench/bench.js --probe      --engine bench/test/mock-engine.js
node bench/bench.js --old-vs-new --games 4 --time 50 --engine bench/test/mock-engine.js
node bench/bench.js --new-vs-new --games 3 --time 20 --time2 50 --engine bench/test/mock-engine.js
```

The mock is deliberately dumb (greedy capture, no search) -- it exists only to
exercise engine verification, per-move stats, JSON output and probe assertions.
Numbers from it say nothing about the real engine.

Engine contract expected by this harness (see `dev/ENGINE_SPEC.md`):
`module.exports = { geometry(size), createEngine({size, playerCount}), hashBoard(board), version }`;
`engine.think(state, {budgetMs, seed, maxPlayouts?, ...})` returns
`{move, visits, playouts, winrate, value, bestMoves, elapsedMs, engine}` where
`move` is a board index, `-1` pass, `-2` resign (2-player only).

---

## Known limitations

- The random player is a floor, not a calibrated opponent; 100% and saturated
  margins are expected and only prove "no crashes / no illegal moves".
- The old AI is a heuristic that is slow on big boards (O(points^2)-ish per
  move): 19-board games take ~15 s each, 25-board games are much slower. Use
  few games for sizes >= 19.
- End-of-game dead-stone detection uses the page's conservative
  `detectDeadStones`; a game ending by pass can remove groups the page would
  also label dead. Games ending by resignation are scored on the current board
  (no dead-stone cleanup), for margin reporting only.
- Multi-player results are per-seat, not zero-sum; with 2-6 players and two
  agents the seat win rate mixes "plays first/second" and seat-count effects.
  `avgDiff` uses best-other-score as the comparison, which is a simple proxy for
  rank.
- Determinism holds for the RNG streams, but a wall-clock engine budget makes
  the engine's own move choice timing-dependent between runs. For reproducible
  engine comparisons use `--playouts` (if the engine honours `maxPlayouts`) and
  the same `--seed`, and expect some variance with time budgets.
- The harness cannot enforce the engine's time budget; an engine that overruns
  slows the run down (visible in `ms/move`).
