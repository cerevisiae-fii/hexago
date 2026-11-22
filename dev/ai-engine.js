/*!
 * HEXAGO AI engine — self-contained MCTS/UCT player for hexagonal Go.
 * Version: 1.0.0
 *
 * Runs in Node (module.exports) and inside a Web Worker (`self.HexagoAI`).
 * No dependencies, no DOM, no network, no eval.  ES2017-compatible.
 *
 * Public API:
 *   geometry(size) -> { size, side, n, P, NB, center, dist(i,j) }
 *   createEngine({ size, playerCount }) -> engine
 *   engine.think(state, options) -> result
 *   hashBoard(board) -> number   (identical to index.html cyrb53 board hash)
 *   version
 *
 * Rules are a 1:1 port of index.html build()/sim()/territory()/finishScore():
 * hex board of odd size 9/13/19/25 (61/127/271/469 points), capture Go,
 * suicide illegal, superko checked only on captures, pass ends the game when
 * all active players pass, score = territory + stones.
 *
 * This file is the single source of truth for the page build: dev/inline-engine.js
 * copies it verbatim into index.html inside the #ai-engine-src script tag.
 */
(function (globalScope) {
  'use strict';

  var VERSION = 'hexago-mcts/3.1.0';

  /* ------------------------------------------------------------------ *
   *  Utilities
   * ------------------------------------------------------------------ */

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  // mulberry32 — small, fast, deterministic PRNG.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // cyrb53 board hash — MUST stay byte-identical to index.html hash(a).
  function hashBoard(a) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < a.length; i++) {
      h1 = Math.imul(h1 ^ a[i], 2654435761);
      h2 = Math.imul(h2 ^ a[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function sizeFromN(n) {
    // points = 3*side*(side-1)+1, side = (size+1)/2
    for (var size = 3; size <= 99; size += 2) {
      var side = (size + 1) / 2;
      if (3 * side * (side - 1) + 1 === n) return size;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   *  Geometry (identical index order to index.html build(n))
   * ------------------------------------------------------------------ */

  var GEO_CACHE = Object.create(null);
  var DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

  function geometry(size) {
    size = size | 0;
    var cached = GEO_CACHE[size];
    if (cached) return cached;
    if (size < 3 || (size & 1) !== 1) throw new Error('HEXAGO geometry: size must be odd and >= 3');
    var side = (size + 1) / 2, radius = side - 1;
    var map = Object.create(null), P = [], q, r, i, d;
    for (r = -radius; r < side; r++) {
      for (q = -radius; q < side; q++) {
        if (Math.abs(q + r) <= radius) { map[q + ',' + r] = P.length; P.push([q, r]); }
      }
    }
    var n = P.length;
    var NB = new Array(n);
    var nbOff = new Int32Array(n + 1);
    var flat = [];
    var dirFlat = [];
    var maskArr = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      var adj = [];
      var mask = 0;
      for (d = 0; d < 6; d++) {
        var j = map[(P[i][0] + DIRS[d][0]) + ',' + (P[i][1] + DIRS[d][1])];
        if (j !== undefined) { adj.push(j); flat.push(j); dirFlat.push(d); mask |= (1 << d); }
      }
      NB[i] = adj;
      nbOff[i] = flat.length - adj.length;
      maskArr[i] = mask;
    }
    nbOff[n] = flat.length;
    // hex distance matrix (build-time only) + ring lists for distance 2 and 3
    var distMat = new Int16Array(n * n);
    var a, b, dq, dr;
    for (a = 0; a < n; a++) {
      for (b = 0; b < n; b++) {
        dq = P[a][0] - P[b][0]; dr = P[a][1] - P[b][1];
        distMat[a * n + b] = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      }
    }
    var r2off = new Int32Array(n + 1), r2flat = [];
    var r3off = new Int32Array(n + 1), r3flat = [];
    for (a = 0; a < n; a++) {
      r2off[a] = r2flat.length; r3off[a] = r3flat.length;
      for (b = 0; b < n; b++) {
        if (distMat[a * n + b] === 2) r2flat.push(b);
        else if (distMat[a * n + b] === 3) r3flat.push(b);
      }
    }
    r2off[n] = r2flat.length; r3off[n] = r3flat.length;
    // opening anchors: centre, hex-distance-2 ring, and 6 axis points at a
    // board-scaled distance (3-line corner analogues; 4/5-line on 19/25).
    var anchorDist = radius >= 12 ? 5 : (radius >= 9 ? 4 : 3);
    var anchors = [];
    var anchorSeen = Object.create(null);
    var center = map['0,0'];
    anchors.push(center); anchorSeen[center] = 1;
    for (b = 0; b < n; b++) if (distMat[center * n + b] === 2 && !anchorSeen[b]) { anchors.push(b); anchorSeen[b] = 1; }
    for (d = 0; d < 6; d++) {
      var ai = map[(DIRS[d][0] * anchorDist) + ',' + (DIRS[d][1] * anchorDist)];
      if (ai !== undefined && !anchorSeen[ai]) { anchors.push(ai); anchorSeen[ai] = 1; }
    }
    var g = {
      size: size,
      side: side,
      n: n,
      P: P,
      NB: NB,
      center: center,
      nbOff: nbOff,
      nbFlat: new Int32Array(flat),
      nbDirFlat: new Int8Array(dirFlat),
      nbMask: maskArr,
      ring2Off: r2off, ring2Flat: new Int32Array(r2flat),
      ring3Off: r3off, ring3Flat: new Int32Array(r3flat),
      openingAnchors: new Int16Array(anchors),
      dist: function (a2, b2) {
        var dq2 = P[a2][0] - P[b2][0], dr2 = P[a2][1] - P[b2][1];
        return Math.max(Math.abs(dq2), Math.abs(dr2), Math.abs(dq2 + dr2));
      }
    };
    GEO_CACHE[size] = g;
    return g;
  }

  /* ------------------------------------------------------------------ *
   *  Engine
   * ------------------------------------------------------------------ */

  var DEFAULT_BUDGET_MS = 2500;

  function createEngine(opts) {
    opts = opts || {};
    var geo = geometry(opts.size | 0);
    var n = geo.n;
    var nbOff = geo.nbOff;
    var nbFlat = geo.nbFlat;
    var engPC = opts.playerCount | 0;
    if (engPC < 2) engPC = 2;
    if (engPC > 6) engPC = 6;

    var UCT_C = opts.uctC != null ? +opts.uctC : 0.70;
    var RAVE_B = opts.raveB != null ? +opts.raveB : 0.04;
    var EXPAND_THRESH = opts.expandThresh != null ? (opts.expandThresh | 0) : 3;
    var PW_K0 = opts.pwK0 != null ? +opts.pwK0 : 8;
    var PW_K1 = opts.pwK1 != null ? +opts.pwK1 : 2.5;
    var USE_PRIOR = opts.usePrior !== false;
    var MARGIN_2P = opts.margin2p != null ? +opts.margin2p : 0.04;
    var TREE_REUSE = opts.treeReuse !== false;
    var RANK_BLEND = opts.rankBlend != null ? Math.max(0, Math.min(1, +opts.rankBlend)) : 0.7;
    var RAVE_K = opts.raveK != null ? +opts.raveK : 1000;
    var MAX_DEPTH = Math.max(40, 2 * n + 40);
    var MAX_PLAYOUT_STEPS = 2 * n + 30;

    /* ---------------- shared group-scan scratch ---------------- */
    var scanStamp = new Int32Array(n), scanId = 0;
    var libStamp = new Int32Array(n), libId = 0;
    var grpBuf = new Int16Array(n), grpN = 0, lastLibs = 0, lastLibPt = -1;
    var applyStamp = new Int32Array(n), applyId = 0;
    var saveStamp = new Int32Array(n), saveId = 0;

    var capCap = 4 * n + 64;
    var capPos = new Int16Array(capCap), capColor = new Int8Array(capCap), capCount = 0;
    var lastCapStart = 0, lastCapEnd = 0, lastKo = -1, lastOwnLibs = 0;

    var srcBoard = new Int8Array(n);    // root position copy
    var simBoard = new Int8Array(n);    // root legality simulation
    var treeBoard = new Int8Array(n);   // traversal position
    var cmpBoard = new Int8Array(n);    // tree-reuse comparison
    var rootCap = new Int16Array(n);    // captures per root legal move (ordering)

    var geomDistCenter = new Int16Array(n);
    for (var gd = 0; gd < n; gd++) geomDistCenter[gd] = geo.dist(gd, geo.center);

    var outFlags = new Uint8Array(8);
    var winArr = new Float64Array(8), valArr = new Float64Array(8);
    var outSc = new Int16Array(8);

    /* ---------------- v2: hex shapes, global candidates, endgame state ---------------- */
    var nbDirFlat = geo.nbDirFlat;
    var nbMask = geo.nbMask;
    var ring2Off = geo.ring2Off, ring2Flat = geo.ring2Flat;
    var ring3Off = geo.ring3Off, ring3Flat = geo.ring3Flat;
    var openingAnchors = geo.openingAnchors;
    var BITIDX = new Int8Array(64);
    for (var bidx = 0; bidx < 6; bidx++) BITIDX[1 << bidx] = bidx;

    var terrStamp = new Int32Array(n), terrId = 0, terrQueue = new Int16Array(n);
    var terrOwner = new Int8Array(n);      // 0 neutral, p>0 = region bordered only by p
    var terrColorCount = new Int8Array(n); // number of border colours of the region
    var terrColMask = new Int8Array(n);    // bit mask of the region's border colours
    var terrSize = new Int16Array(n);      // size (points) of the empty region
    var rootPat = new Int16Array(n);       // hex pattern score per root move
    var rootUseful = new Uint8Array(n);    // 1 = the root move gains something
    var rootLibs = new Int16Array(n);      // own liberties after the root move
    var globalCand = new Int16Array(n), globalCount = 0;
    var globalMark = new Int32Array(n), globalMarkId = 0;
    var FULL_MASK = 0;
    for (var fm = 0; fm < 6; fm++) FULL_MASK |= 1 << fm;
    var stoneCountRoot = 0;
    var emptyRoot = 0;
    var noUsefulRoot = false;
    var lastRootLibs = 0;
    var curC = UCT_C;
    var TERR_SMALL = Math.max(6, (n * 0.12) | 0);   // clearly enclosed: eye / tiny territory
    var TERR_SETTLE = Math.max(TERR_SMALL, (n * 0.25) | 0); // late-game medium territory

    /* ---------------- v2.1: static gain, viability, attack info ---------------- */
    // 面積得点(地+石)の差分で「意味のある手」を判定するための作業領域。
    var GAIN_W = 120;                                 // ordering weight per static point
    var V_MIN = Math.max(8, Math.round(n * 0.06));    // smallest region where a lone stone could even try to live
    // Small boards (<= 80 pts) have short, thin walls: nearly any single-colour
    // region is reducable, so the deep-invasion threshold is much lower there.
    // Measured: the 30%-of-board threshold cost strength on the 61-point board
    // (frozen v2.0.0 out-invaded us 19:8 there at 800 ms).
    var V_DEEP = n <= 80 ? Math.max(9, Math.round(n * 0.15)) : Math.max(14, Math.round(n * 0.30));
    var gainBoard = new Int8Array(n);                 // hypothetical board for one move
    var gainSc = new Int16Array(9);                   // scores after the hypothetical move
    var baseSc = new Int16Array(9);                   // S0: scores if everyone passes now
    var ownGain = new Int16Array(n);                  // static score gain of each root move
    var mvViable = new Uint8Array(n);                // 1 = invasion could live (not obvious dead)
    var mvUseful = new Uint8Array(n);                // 1 = changes score / stabilizes (search candidate)
    var mvSave = new Int16Array(n);                   // own atari groups rescued by the move
    var mvStab = new Uint8Array(n);                   // 1 = adjacent own group has <= 2 liberties
    var mvHopeless = new Uint8Array(n);               // 1 = provably hopeless (own eye / smart-dead / living-enemy dead invasion / settled own fill)
    var mvDiesImm = new Uint8Array(n);                // 1 = newly placed stone removed immediately by detectDeadStonesSmart
    var mvEnemyDrop = new Int16Array(n);              // max opponent score drop caused by move under smart scoring
    var cleanBoard = new Int8Array(n);                // srcBoard after smart dead-stone removal
    var cRegId = new Int32Array(n);                   // empty region id on cleanBoard (-1 for live stone)
    var cRegSize = new Int16Array(n + 8);
    var cRegMask = new Int8Array(n + 8);
    var cRegColCnt = new Int8Array(n + 8);
    var cRegWide = new Int16Array(n + 8);             // points in region with >= 3 empty neighbours (2D interior room)
    var cRegBorderAllAlive = new Uint8Array(n + 8);   // 1 = every bordering stone has >= 2 eyes independent of this region
    var cRegBorderHas1Eye = new Uint8Array(n + 8);    // 1 = every bordering stone has >= 1 eye independent of this region
    var cRegTrappedFor = new Int8Array(n + 8);        // colour trapped inside a 2-eye enemy pocket too small to live
    var cRegCount = 0;
    var cleanGid = new Int32Array(n);
    var cleanLibs = new Int16Array(n);
    var cleanEyes = new Int8Array(n);
    var cleanOwnRegs = new Int8Array(n);
    var cleanGSize = new Int16Array(n);
    var cleanRegSeen = new Int32Array(n + 8), cleanRegSeenId = 0;
    var cleanDameExists = false;
    var LIVE_MIN_2EYE = n <= 80 ? 11 : 15;            // min empty space to realistically live inside a 2-eye enemy wall
    var LIVE_MIN_TINY = n <= 80 ? 9 : 11;             // min empty space inside solid enemy wall without weak enemy groups
    var rootPriorW = new Float64Array(n);             // virtual prior win-sum per root move
    var rootPriorN = new Float64Array(n);             // virtual prior visit count per root move
    var ownNear = new Int16Array(n);                  // hex distance to nearest own stone at root
    var rootOwnCount = 0;                             // number of own stones on root board
    var atkW = new Float64Array(8);                   // per-colour attack weight (multiplayer: hit the leader)
    var atkB = new Int16Array(n);                     // attack ordering bonus per root move
    var atkLibs = new Int16Array(n), atkSize = new Int16Array(n), atkEyes = new Int8Array(n);
    var atkL1 = new Int16Array(n), atkL2 = new Int16Array(n); // liberty points of <=2-lib groups
    var atkStamp = new Int32Array(n), atkId = 0;
    var enemyNear = new Int16Array(n);                // per-point hex distance to the nearest stone of colour e (BFS)
    var bfsQueue = new Int16Array(n * 2);
    var dameExists = false;                           // any 2+-colour empty region left (someone can still gain)
    var enemyThreat = false;                          // an opponent still has a score-changing move
    var GAIN_POLICY = opts.gainPolicy !== false;      // master switch (A/B)
    // Measured: adding 2-lib enemy pressure to the playout policy and attack
    // points to tree expansion both COST strength at equal budget (like every
    // previous playout experiment in section 10).  They stay opt-in for A/B.
    var PLAYOUT_ATK = opts.playoutAtk === true;       // 2-lib pressure in playouts (A/B)
    var TREE_ATK = opts.treeAtk === true;             // weak-group liberties in buildUntried (A/B)
    var ATK_ORDER = opts.atkOrder !== false;          // attack ordering bonus (A/B)
    // Root candidate restriction costs strength at high budgets (the search
    // needs full freedom to prove deep invasions; measured 62.5% vs 37.5% vs
    // frozen v2.0.0 at 800 ms on the 61-point board).  Default OFF; behaviour
    // is instead guaranteed by the final-selection guards + the pass gate.
    var RESTRICT_CAND = opts.restrictCand === true;  // root candidates = useful moves only (A/B)
    var SELF_ATARI_REJECT = (opts.playerCount | 0) >= 4 ? 0.99 : 0.95;

    function pop6(m) { var c = 0; while (m) { m &= m - 1; c++; } return c; }
    function cycDiff(a, b) { var d = a - b; if (d < 0) d = -d; return d > 3 ? 6 - d : d; }

    // Hex-shape score for placing colour `p` at the empty point `i` (board before move).
    //  dirs: 1 = directly adjacent (already connected)
    //        2 = diagonal two-space pair through `i` -> TWO shared liberties (miai)
    //        3 = straight two-space pair through `i` -> ONE shared point (cuttable)
    // This is the "hexago is not go" core: diagonal pairs are strong connections,
    // straight pairs are cutting points.
    function patternScore(board, i, p) {
      var j, je, v, d, ownMask = 0, enMask = 0, ownN = 0, enN = 0;
      for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) {
        v = board[nbFlat[j]];
        if (v === 0) continue;
        d = nbDirFlat[j];
        if (v === p) { ownMask |= 1 << d; ownN++; } else { enMask |= 1 << d; enN++; }
      }
      // own eye: every existing neighbour is our own stone -> never fill it
      if (nbMask[i] !== 0 && ownMask === nbMask[i]) return -420;
      var sc = 0, m, m2, b1, b2, dd;
      m = ownMask;
      while (m) {
        b1 = m & -m; m ^= b1;
        m2 = m;
        while (m2) {
          b2 = m2 & -m2; m2 ^= b2;
          dd = cycDiff(BITIDX[b1], BITIDX[b2]);
          if (dd === 2) sc += 95;       // miai connection (diagonal pair, two shared liberties)
          else if (dd === 3) sc += 58;  // straight pair (one shared point)
          else sc += 10;                // contact
        }
      }
      m = enMask;
      while (m) {
        b1 = m & -m; m ^= b1;
        m2 = m;
        while (m2) {
          b2 = m2 & -m2; m2 ^= b2;
          dd = cycDiff(BITIDX[b1], BITIDX[b2]);
          if (dd === 2) sc += 42;       // one shared liberty of an enemy diagonal pair (peep)
          else if (dd === 3) sc += 72;  // the single shared point of an enemy straight pair = cut
          else sc += 12;
        }
      }
      if (ownN >= 3) sc += 26;          // bamboo-joint / thick connection
      if (enN >= 3) sc += 14;           // contact-fight point
      return sc;
    }

    function ownEyeAt(board, i, p) {
      var j, je;
      if (nbMask[i] === 0) return false;
      for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (board[nbFlat[j]] !== p) return false;
      return true;
    }

    function computeTerritory(board, pc) {
      terrId++;
      dameExists = false;
      var i, j, je, t, v, k, s, qn, mask, cnt, owner, p;
      for (i = 0; i < n; i++) {
        if (board[i] !== 0 || terrStamp[i] === terrId) continue;
        qn = 0; terrQueue[qn++] = i; terrStamp[i] = terrId;
        mask = 0;
        for (k = 0; k < qn; k++) {
          s = terrQueue[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j]; v = board[t];
            if (v === 0) { if (terrStamp[t] !== terrId) { terrStamp[t] = terrId; terrQueue[qn++] = t; } }
            else mask |= (1 << v);
          }
        }
        cnt = pop6(mask); owner = 0;
        if (cnt >= 2) dameExists = true;
        // Only SMALL, single-colour-bordered regions are settled territory/eyes.
        // A large region (even if only our own stones border it) is still open:
        // treating it as settled made the engine ignore defence there and lose
        // whole groups ("passes while the opponent invades/attacks").
        if (cnt === 1 && (qn <= TERR_SMALL || (stoneCountRoot >= n * 0.6 && qn <= TERR_SETTLE))) {
          for (p = 1; p <= pc; p++) if (mask & (1 << p)) { owner = p; break; }
        }
        for (k = 0; k < qn; k++) {
          terrOwner[terrQueue[k]] = owner; terrColorCount[terrQueue[k]] = cnt;
          terrColMask[terrQueue[k]] = mask; terrSize[terrQueue[k]] = qn;
        }
      }
    }

    function nearestStoneDist(board, i) {
      var j, je;
      for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (board[nbFlat[j]] !== 0) return 1;
      for (j = ring2Off[i], je = ring2Off[i + 1]; j < je; j++) if (board[ring2Flat[j]] !== 0) return 2;
      for (j = ring3Off[i], je = ring3Off[i + 1]; j < je; j++) if (board[ring3Flat[j]] !== 0) return 3;
      return 4;
    }

    // hex distance to the nearest own stone, up to maxD (99 = farther).
    function nearestOwnWithin(board, i, p, maxD) {
      var j, je;
      for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (board[nbFlat[j]] === p) return 1;
      if (maxD < 2) return 99;
      for (j = ring2Off[i], je = ring2Off[i + 1]; j < je; j++) if (board[ring2Flat[j]] === p) return 2;
      if (maxD < 3) return 99;
      for (j = ring3Off[i], je = ring3Off[i + 1]; j < je; j++) if (board[ring3Flat[j]] === p) return 3;
      return 99;
    }

    // enemyNear[i] = hex distance from i to the nearest stone of `colour`
    // (BFS, capped at maxD; 99 when farther). Used for invasion-support tests.
    function fillColorNear(board, colour, maxD) {
      var i, j, je, t, head, tail, layerEnd, d;
      for (i = 0; i < n; i++) enemyNear[i] = 99;
      head = 0; tail = 0;
      for (i = 0; i < n; i++) if (board[i] === colour) { enemyNear[i] = 0; bfsQueue[tail++] = i; }
      for (d = 0; d < maxD && head < tail; d++) {
        layerEnd = tail;
        while (head < layerEnd) {
          var s = bfsQueue[head++];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j];
            if (enemyNear[t] > d + 1) { enemyNear[t] = d + 1; if (d + 1 < maxD) bfsQueue[tail++] = t; }
          }
        }
      }
    }

    // S0 baseline & region/life-and-death analysis on srcBoard + smart-dead map.
    // IMPORTANT: region ownership and group eye counts are analysed on srcBoard
    // (NOT after erasing unfinished <2-eye groups!), so a player's own 0/1-eye
    // group is never erased and always keeps full freedom to make two eyes.
    // `cleanBoard` is used strictly to identify stones already dead under the
    // page's detectDeadStonesSmart scorer.
    function computeBaseline(pc) {
      cleanBoard.set(srcBoard);
      if (stoneCountRoot >= 4) removeDeadStonesSmartImpl(cleanBoard, pc);
      scoreBoardInto(cleanBoard, baseSc, pc);
      analyzeRootRegions(pc);
    }

    // Analyse empty regions and live/2-eye groups on srcBoard, plus cross-check
    // against cleanBoard for already-smart-dead stones inside 2-eye territories.
    function analyzeRootRegions(pc) {
      var i, j, je, t, v, k, s, qn, mask, cnt, wide, empNb, rid = 0;
      cleanDameExists = false;
      for (i = 0; i < n; i++) { cRegId[i] = -1; cleanGid[i] = 0; }
      for (i = 0; i < n; i++) {
        if (srcBoard[i] !== 0 || cRegId[i] >= 0) continue;
        qn = 0; terrQueue[qn++] = i; cRegId[i] = rid;
        mask = 0; wide = 0;
        for (k = 0; k < qn; k++) {
          s = terrQueue[k]; empNb = 0;
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j]; v = srcBoard[t];
            if (v === 0) {
              empNb++;
              if (cRegId[t] < 0) { cRegId[t] = rid; terrQueue[qn++] = t; }
            } else {
              mask |= (1 << v);
            }
          }
          if (empNb >= 3) wide++;
        }
        cnt = pop6(mask);
        if (cnt >= 2) cleanDameExists = true;
        cRegSize[rid] = qn;
        cRegMask[rid] = mask;
        cRegColCnt[rid] = cnt;
        cRegWide[rid] = wide;
        cRegBorderAllAlive[rid] = mask !== 0 ? 1 : 0;
        cRegBorderHas1Eye[rid] = mask !== 0 ? 1 : 0;
        cRegTrappedFor[rid] = 0;
        rid++;
      }
      cRegCount = rid;

      // Scan all groups on srcBoard: liberties, single-point eyes, distinct own-only regions
      for (i = 0; i < n; i++) {
        var c = srcBoard[i];
        if (c === 0 || cleanGid[i] !== 0) continue;
        var libs = scanGroupFull(srcBoard, i, c);
        var gi = grpN;
        var gid = ++dsGroupId;
        for (k = 0; k < gi; k++) { cleanGid[grpBuf[k]] = gid; dsGMark[grpBuf[k]] = gid; }
        var eyes = groupEyeCount(srcBoard, c, gid);
        var sid = ++cleanRegSeenId, ownRegs = 0;
        for (k = 0; k < gi; k++) {
          s = grpBuf[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j];
            if (srcBoard[t] !== 0) continue;
            var r2 = cRegId[t];
            if (r2 >= 0 && cRegColCnt[r2] === 1 && (cRegMask[r2] & (1 << c)) && cleanRegSeen[r2] !== sid) {
              cleanRegSeen[r2] = sid;
              ownRegs++;
            }
          }
        }
        for (k = 0; k < gi; k++) {
          var st2 = grpBuf[k];
          cleanLibs[st2] = libs; cleanEyes[st2] = eyes;
          cleanOwnRegs[st2] = ownRegs; cleanGSize[st2] = gi;
        }
      }

      // Check per-region whether every bordering group on srcBoard is already
      // 2-eye alive (or already has >= 1 eye) independent of this region.
      for (i = 0; i < n; i++) {
        var r0 = cRegId[i];
        if (r0 < 0 || (!cRegBorderAllAlive[r0] && !cRegBorderHas1Eye[r0])) continue;
        for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) {
          t = nbFlat[j];
          var tc = srcBoard[t];
          if (tc === 0) continue;
          var selfOnly = (cRegColCnt[r0] === 1 && (cRegMask[r0] & (1 << tc)));
          var otherOwn = cleanOwnRegs[t] - (selfOnly ? 1 : 0);
          var otherEyes = cleanEyes[t] - (selfOnly && cRegSize[r0] === 1 ? 1 : 0);
          if (otherOwn < 2 && otherEyes < 2) cRegBorderAllAlive[r0] = 0;
          if (otherOwn < 1 && otherEyes < 1) cRegBorderHas1Eye[r0] = 0;
        }
      }

      // Detect trapped 0-eye stones sitting inside a 2-eye living enemy pocket
      // (2-colour region on srcBoard where wallC is 2-eye alive independent of
      // the pocket and every trapC group touching the pocket has 0 eyes, touches
      // ONLY this pocket, and total stones + empty space is too small/narrow to
      // make 2 eyes — OR all trapC stones are already smart-dead on cleanBoard).
      for (var rIdx = 0; rIdx < cRegCount; rIdx++) {
        if (cRegColCnt[rIdx] !== 2) continue;
        var m = cRegMask[rIdx], c1 = 0, c2 = 0;
        for (var cp = 1; cp <= pc; cp++) {
          if (m & (1 << cp)) { if (c1 === 0) c1 = cp; else c2 = cp; }
        }
        if (!c1 || !c2) continue;
        for (var passIdx = 0; passIdx < 2; passIdx++) {
          var trapC = passIdx === 0 ? c1 : c2;
          var wallC = passIdx === 0 ? c2 : c1;
          var wallAlive = true, trapOk = true, trapAllSmartDead = true, trapStones = 0;
          var seenG = ++cleanRegSeenId;
          for (i = 0; i < n && wallAlive && trapOk; i++) {
            if (cRegId[i] !== rIdx) continue;
            for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) {
              t = nbFlat[j]; var colT = srcBoard[t];
              if (colT === 0) continue;
              if (colT === wallC) {
                if (cleanOwnRegs[t] < 2 && cleanEyes[t] < 2) { wallAlive = false; break; }
              } else if (colT === trapC) {
                if (cleanBoard[t] !== 0) trapAllSmartDead = false;
                if (cleanEyes[t] > 0 || cleanOwnRegs[t] > 0) { trapOk = false; break; }
                var gidT = cleanGid[t];
                if (cleanRegSeen[t] !== seenG) {
                  var allInR = true;
                  for (var q2 = 0; q2 < n; q2++) {
                    if (cleanGid[q2] !== gidT) continue;
                    cleanRegSeen[q2] = seenG;
                    if (cleanBoard[q2] !== 0) trapAllSmartDead = false;
                    trapStones++;
                    for (var j2 = nbOff[q2], je2 = nbOff[q2 + 1]; j2 < je2; j2++) {
                      var u2 = nbFlat[j2];
                      if (srcBoard[u2] === 0 && cRegId[u2] !== rIdx) { allInR = false; break; }
                    }
                  }
                  if (!allInR && !trapAllSmartDead) { trapOk = false; break; }
                }
              }
            }
          }
          if (wallAlive && trapOk && trapStones > 0 && (trapAllSmartDead || trapStones + cRegSize[rIdx] < LIVE_MIN_2EYE || cRegWide[rIdx] < 3)) {
            // Positive value = trapC is trapped (invader cannot live);
            // encode +trapC if NOT all smart-dead yet, or -(trapC) if ALREADY smart-dead
            // (so wallC also knows it doesn't need to waste moves killing already-dead stones!)
            cRegTrappedFor[rIdx] = trapAllSmartDead ? -trapC : trapC;
            break;
          }
        }
      }
    }

    // Static score gain of playing `mv` under the REAL page scorer
    // (detectDeadStonesSmart): place, clean dead stones, score, and compare
    // against S0. Also records whether the newly placed stone dies immediately
    // (`mvDiesImm`) and whether any opponent loses score (`mvEnemyDrop`).
    function staticGainFor(mv, p, pc) {
      gainBoard.set(srcBoard);
      capCount = 0;
      if (!applyMove(gainBoard, mv, p)) { capCount = 0; mvDiesImm[mv] = 1; mvEnemyDrop[mv] = 0; return -32768; }
      capCount = 0;
      if (stoneCountRoot >= 4) removeDeadStonesSmartImpl(gainBoard, pc);
      scoreBoardInto(gainBoard, gainSc, pc);
      mvDiesImm[mv] = gainBoard[mv] === 0 ? 1 : 0;
      var maxDrop = 0;
      for (var e = 1; e <= pc; e++) {
        if (e === p || outFlags[e]) continue;
        var dr = baseSc[e] - gainSc[e];
        if (dr > maxDrop) maxDrop = dr;
      }
      mvEnemyDrop[mv] = maxDrop;
      return gainSc[p] - baseSc[p];
    }

    // Group table for the root position: per-stone liberties/size/eyes.
    // Feeds (i) the attack-ordering bonus on weak enemy groups and
    // (ii) own-weakness detection for the pass gate. Returns ownWeak:
    // true when we have a group with <= 2 liberties and < 2 eyes.
    function computeAttackInfo(turn, pc) {
      atkId++;
      var i, j, k, c, gi, libs, eyes, gid, e, best, worst;
      best = -1; worst = -1;
      for (e = 1; e <= pc; e++) {
        if (e === turn || outFlags[e]) continue;
        if (best < 0 || baseSc[e] > baseSc[best]) best = e;
        if (worst < 0 || baseSc[e] < baseSc[worst]) worst = e;
      }
      for (e = 1; e <= pc; e++) atkW[e] = 1;
      if (pc >= 3 && best > 0) atkW[best] = 1.25;                       // hit the leader
      if (pc >= 3 && worst > 0 && worst !== best) atkW[worst] = 0.7;   // spare the last
      var ownWeak = false, hasEnemy = false;
      for (i = 0; i < n; i++) {
        c = srcBoard[i];
        if (c !== 0 && c !== turn) hasEnemy = true;
        if (c === 0 || atkStamp[i] === atkId) continue;
        libs = scanGroupFull(srcBoard, i, c);
        gi = grpN;
        gid = ++dsGroupId;
        for (k = 0; k < gi; k++) { atkStamp[grpBuf[k]] = atkId; dsGMark[grpBuf[k]] = gid; }
        eyes = groupEyeCount(srcBoard, c, gid);
        for (k = 0; k < gi; k++) { atkLibs[grpBuf[k]] = libs; atkSize[grpBuf[k]] = gi; atkEyes[grpBuf[k]] = eyes; }
        if (libs <= 2) {
          for (k = 0; k < gi; k++) {
            atkL1[grpBuf[k]] = libs >= 1 ? dsLibs[0] : -1;
            atkL2[grpBuf[k]] = libs >= 2 ? dsLibs[1] : -1;
          }
        }
        // a <=2-lib group is only a pass-blocking weakness when an opponent
        // is actually on the board to capture it (degenerate no-enemy boards
        // must still pass as frozen).
        if (c === turn && libs <= 2 && eyes < 2 && hasEnemy) ownWeak = true;
      }
      return ownWeak;
    }

    // Ordering bonus for moves that pressure a weak enemy group (its liberty).
    // Scaled by the group's size and by atkW (multiplayer: attack the leader).
    // A "certain kill" (their other liberty is fully enclosed, so after this
    // move their only save is suicide) is worth the full capture in ordering:
    // playout noise on big open boards can hide an N-stone capture otherwise.
    function atkBonusAt(mv, turn) {
      var j, je, s, c, b = 0;
      for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
        s = nbFlat[j]; c = srcBoard[s];
        if (c === 0 || c === turn) continue;
        if (cleanBoard[s] === 0) continue; // already dead under detectDeadStonesSmart: no bonus for poking dead stones
        if (atkLibs[s] > 3 || atkEyes[s] >= 2) continue;
        var dup = false;
        for (var j2 = nbOff[mv]; j2 < j; j2++) {
          var s0 = nbFlat[j2];
          if (srcBoard[s0] === c && dsGMark[s0] === dsGMark[s]) { dup = true; break; }
        }
        if (dup) continue;
        var w = atkLibs[s] === 1 ? 6 : (atkLibs[s] === 2 ? 4 : 1.5);
        b += w * Math.min(atkSize[s], 12) * atkW[c];
        // certain kill: group at 2 libs, this move takes one, the other liberty
        // has no empty neighbour left -> their group is dead next turn.
        if (atkLibs[s] === 2 && rootLibs[mv] >= 2) {
          var lp2 = atkL1[s] === mv ? atkL2[s] : atkL1[s];
          if (lp2 >= 0) {
            var open = 0, j3, je3;
            for (j3 = nbOff[lp2], je3 = nbOff[lp2 + 1]; j3 < je3; j3++) {
              var t3 = nbFlat[j3];
              if (srcBoard[t3] === 0 && t3 !== mv) open++;
            }
            if (open === 0) b += Math.min(atkSize[s], 12) * 80 * atkW[c];
          }
        }
      }
      return (b * 24) | 0;
    }

    function buildGlobalCandidates() {
      globalMarkId++;
      globalCount = 0;
      var i, a, j, je, e, adj;
      for (i = 0; i < openingAnchors.length && globalCount < 24; i++) {
        a = openingAnchors[i];
        if (srcBoard[a] === 0 && globalMark[a] !== globalMarkId) { globalMark[a] = globalMarkId; globalCand[globalCount++] = a; }
      }
      var tries = 0;
      while (globalCount < 26 && tries < 80) {
        tries++;
        e = (rng() * n) | 0;
        if (srcBoard[e] !== 0 || globalMark[e] === globalMarkId) continue;
        adj = 0;
        for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (srcBoard[nbFlat[j]] !== 0) { adj = 1; break; }
        if (adj) continue;
        globalMark[e] = globalMarkId; globalCand[globalCount++] = e;
      }
    }

    // Classify every root move.  v2.1 gain policy: a move is a search candidate
    // only when it changes the area score (static gain vs the pass-now baseline),
    // rescues/stabilizes own weak groups, or attacks/threatens an enemy group.
    // Invasions of small or supportless enemy regions are dead stones -> gain 0.
    // Legacy v2 classification is kept under opts.gainPolicy=false for A/B.
    function classifyRootMoves(legal, turn) {
      computeTerritory(srcBoard, pcCur);
      var ownWeak = false;
      if (GAIN_POLICY) {
        computeBaseline(pcCur);
        ownWeak = computeAttackInfo(turn, pcCur);
      }
      noUsefulRoot = true;
      var i, mv, j, je, ownN, enN, useful, owner, eye;
      var libs, inv, viable, g, nd, nearWeakEn;
      for (i = 0; i < legal.length; i++) {
        mv = legal[i];
        if (mv < 0) continue;
        rootPat[mv] = patternScore(srcBoard, mv, turn);
        ownN = 0; enN = 0;
        for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
          var v = srcBoard[nbFlat[j]];
          if (v === turn) ownN++; else if (v !== 0) enN++;
        }
        eye = ownEyeAt(srcBoard, mv, turn);
        owner = terrOwner[mv];
        mvSave[mv] = countSavesAt(srcBoard, mv, turn);
        mvStab[mv] = (!eye && countStabAt(srcBoard, mv, turn) > 0) ? 1 : 0;
        libs = rootLibs[mv];
        if (!GAIN_POLICY) {
          // ---- v2.0.0 legacy classification (A/B reference) ----
          useful = rootCap[mv] > 0;
          if (!useful && rootPat[mv] >= 40) useful = true;                     // connection / cut
          if (!useful) {
            var openPhase = emptyRoot > Math.max(4, (n * 0.35) | 0);
            var safe = libs >= 2;
            var bigRegion = terrSize[mv] > TERR_SMALL;
            if (openPhase && safe) useful = true;                              // open board: claim space safely
            else if (safe && terrColorCount[mv] >= 2) useful = true;           // real dame, +1
            else if (safe && bigRegion) useful = true;                         // large open area: defend/invade, never pass
          }
          if (owner === turn && terrSize[mv] <= TERR_SMALL && rootCap[mv] === 0) useful = false; // own SMALL settled territory
          if (eye && rootCap[mv] === 0) useful = false;                        // own eye
          if (libs === 1 && rootCap[mv] === 0) useful = false;                 // self-atari
          mvUseful[mv] = useful ? 1 : 0;
          if (useful) noUsefulRoot = false;
          continue;
        }
        // ---- v3.1 smart-scorer gain & dead-invasion eradication policy ----
        var rid = cRegId[mv];
        var cMask = rid >= 0 ? cRegMask[rid] : 0;
        var cCnt = rid >= 0 ? cRegColCnt[rid] : 0;
        var cSize = rid >= 0 ? cRegSize[rid] : 0;
        var cWide = rid >= 0 ? cRegWide[rid] : 0;
        var cAlive = rid >= 0 ? cRegBorderAllAlive[rid] : 0;
        var cHas1Eye = rid >= 0 ? cRegBorderHas1Eye[rid] : 0;
        var cTrap = rid >= 0 ? cRegTrappedFor[rid] : 0;
        var hasAnyEnemy = false;
        for (var pe = 1; pe <= pcCur; pe++) if (pe !== turn && baseSc[pe] > 0) { hasAnyEnemy = true; break; }
        if (!hasAnyEnemy) {
          for (var bi0 = 0; bi0 < n; bi0++) if (srcBoard[bi0] !== 0 && srcBoard[bi0] !== turn) { hasAnyEnemy = true; break; }
        }
        // Enemy-only region on srcBoard
        inv = cCnt === 1 && !(cMask & (1 << turn));
        var anyEnemyOnly = rid >= 0 && cMask !== 0 && !(cMask & (1 << turn));
        var ownSrcOnly = rid >= 0 && cCnt === 1 && (cMask & (1 << turn));
        // Does it touch a LIVE weak enemy group (ignoring already-smart-dead stones)?
        nearWeakEn = 0;
        for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
          var s = nbFlat[j];
          if (cleanBoard[s] !== 0 && cleanBoard[s] !== turn && cleanLibs[s] <= 3 && cleanEyes[s] < 2 && cleanOwnRegs[s] < 2) {
            nearWeakEn = 1; break;
          }
        }
        // Does it rescue/stabilize an own group on srcBoard?
        var saveOwn = mvSave[mv] > 0;
        var stabOwn = mvStab[mv] > 0;
        // Compute exact smart-scorer static gain, immediate death, and enemy drop
        g = staticGainFor(mv, turn, pcCur);
        var diesImm = mvDiesImm[mv];
        var enDrop = mvEnemyDrop[mv];
        // Did `mv` capture any enemy stone that was ALIVE on cleanBoard?
        // Capturing ONLY stones that were already dead under detectDeadStonesSmart
        // while our own stone also immediately dies is pure 0-gain noise.
        var capLive = 0;
        if (rootCap[mv] > 0) {
          for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
            var sc2 = nbFlat[j];
            if (cleanBoard[sc2] !== 0 && cleanBoard[sc2] !== turn && cleanLibs[sc2] === 1) { capLive = 1; break; }
          }
        }

        // Hopeless-move classification (unconditionally excluded from root
        // candidates and multi-worker rootMoves so neither fast nor beta mode
        // ever dumps dead stones into 2-eye enemy territories or recycles dead
        // captures, while NEVER blocking eye-making for unfinished own groups
        // or attacks against <2-eye enemy walls).
        var hopeless = 0;
        if (eye && rootCap[mv] === 0) {
          // Rule 1: pure own eye — NEVER fill
          hopeless = 1;
        } else if (diesImm && ownN === 0 && capLive === 0 && g <= 0 && enDrop <= 0 && !nearWeakEn) {
          // Rule 2: lone stone dropped into enclosed space that detectDeadStonesSmart
          // immediately removes with <= 0 score effect (even if it captures an
          // already-smart-dead stone in a 3rd player's territory).
          hopeless = 1;
        } else if (inv && cAlive && rootCap[mv] === 0 && !saveOwn && !nearWeakEn) {
          // Rule 3: single-enemy territory whose surrounding wall ALREADY has 2 eyes!
          // Cannot kill the 2-eye wall, so invasion only makes sense if the pocket
          // has enough 2D space to make 2 eyes inside (do NOT trust pass-now gain).
          if (cSize < LIVE_MIN_2EYE || cWide < 3 || libs < 3) hopeless = 1;
        } else if (inv && cHas1Eye && cSize >= 4 && cSize < LIVE_MIN_TINY && rootCap[mv] === 0 && !saveOwn && !nearWeakEn) {
          // Rule 3a: surrounding enemy already has 1 eye outside + a 4..10pt pocket
          // (trivially keeps a 2nd eye inside while killing a lone invader).
          hopeless = 1;
        } else if (anyEnemyOnly && !inv && cAlive && rootCap[mv] === 0 && !saveOwn && !nearWeakEn) {
          // Rule 3b: multi-enemy pocket whose bordering walls ALL have 2 eyes
          if (cSize < LIVE_MIN_TINY || cWide < 2 || libs < 3) hopeless = 1;
        } else if (cTrap !== 0 && rootCap[mv] === 0 && !saveOwn && !nearWeakEn) {
          // Rule 4: trapped 0-eye stones inside a 2-eye living enemy pocket:
          // - If turn === Math.abs(cTrap): turn is the trapped invader -> never pile more dead stones!
          // - If cTrap < 0 (already smart-dead on cleanBoard) and turn !== -cTrap:
          //   turn is the 2-eye defender -> no need to waste moves killing already-dead stones!
          if (turn === Math.abs(cTrap)) hopeless = 1;
          else if (cTrap < 0 && g <= 0 && enDrop <= 0) hopeless = 1;
        } else if (ownSrcOnly && rootCap[mv] === 0 && g <= 0 && enDrop <= 0 && !saveOwn && !stabOwn) {
          // Rule 5: own settled territory — ONLY forbid when our bordering wall
          // already has 2 eyes (or no enemies exist on the board, or pocket <= 2 pts
          // where filling cannot create 2 eyes). Never blocks a <2-eye group from
          // splitting a 4..10pt space into 2 eyes!
          if (!hasAnyEnemy && cSize < LIVE_MIN_TINY) hopeless = 1;
          else if (cAlive && (cSize < LIVE_MIN_2EYE || cWide < 2)) hopeless = 1;
          else if (cSize <= 2) hopeless = 1;
        }

        mvHopeless[mv] = hopeless;
        viable = hopeless ? 0 : 1;
        mvViable[mv] = viable;
        if (hopeless) g = 0;
        ownGain[mv] = g;
        // Useful: anything non-hopeless that can move the score, fight, save, or make eyes
        useful = !hopeless && (
          g > 0 || enDrop > 0 || rootCap[mv] > 0 ||
          (saveOwn && libs >= 2) ||
          (stabOwn && libs >= 2) ||
          (cCnt >= 2 && libs >= 2) ||
          (!ownSrcOnly && !anyEnemyOnly && libs >= 2) ||
          (ownSrcOnly && !cAlive && hasAnyEnemy && cSize >= 3 && libs >= 2) ||
          (inv && !cAlive && libs >= 2)
        );
        if (eye && rootCap[mv] === 0) useful = false;
        if (libs === 1 && rootCap[mv] === 0) useful = false;
        mvUseful[mv] = useful ? 1 : 0;
        atkB[mv] = (ATK_ORDER && !hopeless) ? atkBonusAt(mv, turn) : 0;
        if (useful) noUsefulRoot = false;
      }
      if (GAIN_POLICY) computeEnemyThreat(turn, pcCur, ownWeak);
      return noUsefulRoot;
    }

    // Can any active opponent still change the score? (blocks the pass gate)
    function computeEnemyThreat(turn, pc, ownWeak) {
      // Check if we have any <2-eye weak group when opponents exist
      var liveOwnWeak = false, hasLiveEnemy = false, i;
      for (i = 0; i < n; i++) if (srcBoard[i] !== 0 && srcBoard[i] !== turn) { hasLiveEnemy = true; break; }
      if (hasLiveEnemy) {
        for (i = 0; i < n; i++) {
          if (srcBoard[i] === turn && cleanLibs[i] <= 2 && cleanEyes[i] < 2 && cleanOwnRegs[i] < 2 && cleanBoard[i] === turn) {
            liveOwnWeak = true; break;
          }
        }
      }
      // Real dame: 2+-colour region on srcBoard that is NOT a trapped-in-2-eye-pocket dead region
      var realDame = false;
      for (var rIdx = 0; rIdx < cRegCount; rIdx++) {
        if (cRegColCnt[rIdx] >= 2 && cRegTrappedFor[rIdx] === 0) { realDame = true; break; }
      }
      enemyThreat = liveOwnWeak || realDame;
      if (enemyThreat) return;
      var e, j, je, libs;
      for (e = 1; e <= pc && !enemyThreat; e++) {
        if (e === turn || outFlags[e]) continue;
        fillColorNear(srcBoard, e, 4);
        for (i = 0; i < n; i++) {
          if (srcBoard[i] !== 0) continue;
          var r0 = cRegId[i];
          if (r0 < 0 || cRegColCnt[r0] !== 1 || !(cRegMask[r0] & (1 << turn))) continue;
          var minSz = cRegBorderAllAlive[r0] ? LIVE_MIN_2EYE : LIVE_MIN_TINY;
          if (cRegSize[r0] < minSz || cRegWide[r0] < (cRegBorderAllAlive[r0] ? 3 : 2)) continue;
          libs = 0;
          for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (srcBoard[nbFlat[j]] === 0) libs++;
          if (libs < 3) continue;
          if (enemyNear[i] <= 3 || (cRegSize[r0] >= V_DEEP && libs >= 4)) { enemyThreat = true; break; }
        }
      }
    }


    var pcCur = engPC;      // players in current think()
    var activeCount = pcCur;
    var rootMover = 1;
    var seenSet = null;

    /* ---------------- group helpers ---------------- */

    // maxLibs: exact liberty count is only needed when it is 0 or 1 (atari /
    // suicide / self-atari tests); when the group provably has >= maxLibs
    // liberties the flood fill may stop early.  Because the early exit only
    // fires after finding maxLibs distinct liberties, callers that read grpN
    // (group stones) must only do so when lastLibs < maxLibs.
    function scanGroup(board, start, color, maxLibs) {
      var sid = ++scanId;
      var lid = ++libId;
      grpN = 0;
      grpBuf[grpN++] = start;
      scanStamp[start] = sid;
      var libs = 0, libPt = -1;
      for (var gi = 0; gi < grpN; gi++) {
        var s = grpBuf[gi];
        for (var j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
          var t = nbFlat[j], v = board[t];
          if (v === color) {
            if (scanStamp[t] !== sid) { scanStamp[t] = sid; grpBuf[grpN++] = t; }
          } else if (v === 0 && libStamp[t] !== lid) {
            libStamp[t] = lid; libs++; libPt = t;
            if (maxLibs !== undefined && libs >= maxLibs) { lastLibs = libs; lastLibPt = libPt; return libs; }
          }
        }
      }
      lastLibs = libs; lastLibPt = libPt;
      return libs;
    }

    // Apply (assumed-empty) move for the tree / root simulation.
    // Returns 1 if legal, 0 if suicide. Captured stones are pushed on the shared
    // capture stack so the caller can undo with undoMove().
    function applyMove(board, move, p) {
      board[move] = p;
      var capStart = capCount;
      var aid = ++applyId;
      var j, je, t, c, gi, k, captured = 0;
      for (j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        t = nbFlat[j]; c = board[t];
        if (c === 0 || c === p || applyStamp[t] === aid) continue;
        if (scanGroup(board, t, c, 1) !== 0) continue; // has a liberty -> no capture
        gi = grpN;
        for (k = 0; k < gi; k++) applyStamp[grpBuf[k]] = aid;
        for (k = 0; k < gi; k++) { capPos[capCount] = grpBuf[k]; capColor[capCount] = c; capCount++; captured++; }
      }
      if (captured > 0) {
        for (k = capStart; k < capCount; k++) board[capPos[k]] = 0;
        lastCapStart = capStart; lastCapEnd = capCount;
        lastKo = captured === 1 ? capPos[capStart] : -1;
        lastOwnLibs = 2;
        return 1;
      }
      scanGroup(board, move, p, 2);
      if (lastLibs === 0) {
        board[move] = 0;
        lastCapStart = capStart; lastCapEnd = capCount; lastKo = -1; lastOwnLibs = 0;
        return 0;
      }
      lastCapStart = capStart; lastCapEnd = capCount; lastKo = -1; lastOwnLibs = lastLibs;
      return 1;
    }

    function undoMove(board, move, capStart, capEnd) {
      board[move] = 0;
      for (var k = capStart; k < capEnd; k++) board[capPos[k]] = capColor[k];
      capCount = capStart;
    }

    /* ---------------- scoring (territory + stones) ---------------- */

    var regStamp = new Int32Array(n), regId = 0, regQueue = new Int16Array(n);
    var scoreScratch = new Int16Array(9);

    function scoreBoardInto(board, out, pc) {
      var i, j, je, t, p, qn, s, qi, v, col, mixed, rid;
      for (p = 1; p <= pc; p++) out[p] = 0;
      for (i = 0; i < n; i++) { t = board[i]; if (t !== 0 && t <= pc) out[t]++; }
      rid = ++regId;
      for (i = 0; i < n; i++) {
        if (board[i] !== 0 || regStamp[i] === rid) continue;
        qn = 0; regQueue[qn++] = i; regStamp[i] = rid;
        col = 0; mixed = false;
        for (qi = 0; qi < qn; qi++) {
          s = regQueue[qi];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j]; v = board[t];
            if (v === 0) {
              if (regStamp[t] !== rid) { regStamp[t] = rid; regQueue[qn++] = t; }
            } else if (col === 0) { col = v; } else if (v !== col) { mixed = true; }
          }
        }
        if (!mixed && col !== 0 && col <= pc) out[col] += qn;
      }
      out[0] = 0;
      return out;
    }

    /* ---------------- end-of-game dead-stone cleanup (page detectDeadStones) ---------------- */
    var dsBoard = new Int8Array(n);
    var dsSeen = new Int32Array(n), dsSeenId = 0;
    var dsGMark = new Int32Array(n), dsGroupId = 0;
    var dsLibs = new Int16Array(n);
    var dsDead = new Int16Array(n), dsDeadN = 0;
    var dsEyeStamp = new Int32Array(n), dsEyeId = 0;

    // Group + full liberty list (page group()+libCount with the actual points).
    function scanGroupFull(board, start, color) {
      var sid = ++scanId, lid = ++libId;
      grpN = 0; grpBuf[grpN++] = start; scanStamp[start] = sid;
      var libN = 0;
      for (var gi = 0; gi < grpN; gi++) {
        var st = grpBuf[gi];
        for (var j = nbOff[st], je = nbOff[st + 1]; j < je; j++) {
          var t = nbFlat[j], v = board[t];
          if (v === color) { if (scanStamp[t] !== sid) { scanStamp[t] = sid; grpBuf[grpN++] = t; } }
          else if (v === 0 && libStamp[t] !== lid) { libStamp[t] = lid; dsLibs[libN++] = t; }
        }
      }
      lastLibs = libN;
      return libN;
    }

    // Page countEyes(b, g, color): empty neighbours of the group whose own
    // neighbours are all the group's colour (or the group itself).
    function groupEyeCount(board, color, gid) {
      var eid = ++dsEyeId, eyes = 0;
      for (var k = 0; k < grpN; k++) {
        var st = grpBuf[k];
        for (var j = nbOff[st], je = nbOff[st + 1]; j < je; j++) {
          var l = nbFlat[j];
          if (board[l] !== 0 || dsEyeStamp[l] === eid) continue;
          if (nbOff[l + 1] - nbOff[l] < 3) continue;
          var ok = true;
          for (var j2 = nbOff[l], je2 = nbOff[l + 1]; j2 < je2; j2++) {
            var x = nbFlat[j2], v = board[x];
            if (v !== color && dsGMark[x] !== gid) { ok = false; break; }
          }
          if (ok) { dsEyeStamp[l] = eid; eyes++; }
        }
      }
      return eyes;
    }

    // Conservative dead-stone removal, byte-for-byte page detectDeadStones()
    // semantics: no eyes, liberties <= 2, every liberty surrounded by exactly
    // one enemy colour with <= 1 friendly stone, and one enemy colour adjacent.
    function removeDeadStones(board) {
      dsSeenId++; dsDeadN = 0;
      var i, k, j, je, s, v, gN, libN, ok, enemyCol, mixed;
      for (i = 0; i < n; i++) {
        var color = board[i];
        if (color === 0 || dsSeen[i] === dsSeenId) continue;
        libN = scanGroupFull(board, i, color);
        gN = grpN;
        dsGroupId++;
        var gid = dsGroupId;
        for (k = 0; k < gN; k++) { dsSeen[grpBuf[k]] = dsSeenId; dsGMark[grpBuf[k]] = gid; }
        if (libN === 0 || libN > 2) continue;
        if (groupEyeCount(board, color, gid) > 0) continue;
        ok = true;
        for (k = 0; k < libN && ok; k++) {
          var l = dsLibs[k], around = 0, friendly = 0;
          var nlen = nbOff[l + 1] - nbOff[l];
          for (j = nbOff[l], je = nbOff[l + 1]; j < je; j++) {
            v = board[nbFlat[j]];
            if (v === 0) continue;
            if (v === color) friendly++; else around++;
          }
          if (!(around >= Math.max(2, nlen - 2) && friendly <= 1)) ok = false;
        }
        if (!ok) continue;
        enemyCol = 0; mixed = false;
        for (k = 0; k < gN && !mixed; k++) {
          s = grpBuf[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            v = board[nbFlat[j]];
            if (v === 0 || v === color) continue;
            if (enemyCol === 0) enemyCol = v; else if (v !== enemyCol) { mixed = true; break; }
          }
        }
        if (mixed || enemyCol === 0) continue;
        for (k = 0; k < gN; k++) dsDead[dsDeadN++] = grpBuf[k];
      }
      for (k = 0; k < dsDeadN; k++) board[dsDead[k]] = 0;
      return dsDeadN;
    }

    function deadStonesImpl(board) {
      dsBoard.set(board);
      removeDeadStones(dsBoard);
      var out = [];
      for (var i = 0; i < n; i++) if (board[i] !== 0 && dsBoard[i] === 0) out.push(i);
      return out;
    }

    /* ---------------------------------------------------------------- *
     *  v2.2: smart dead-stone cleanup - faithful port of the page's
     *  detectDeadStonesSmart (region-enclosed no-two-eye groups get a local
     *  alternating-enemy capture search).  The page scores pass-end games
     *  with THIS logic, so terminal values that only use the conservative
     *  list misprice groups the referee would kill: hopeless invasions look
     *  alive and killable groups look safe.  Used at every scoring point;
     *  the conservative removeDeadStones() stays for the self-test's 1:1
     *  page-detectDeadStones parity checks.
     * ---------------------------------------------------------------- */
    var smBoard = new Int8Array(n);
    var smGrp = new Int16Array(n), smGrpN = 0;
    var smLibs = new Int16Array(n);
    var smStamp = new Int32Array(n), smStampId = 0;
    var smRegId = new Int32Array(n);
    var smRegCols = new Int8Array(n + 8), smRegSize = new Int16Array(n + 8);
    var smRegQueue = new Int16Array(n);
    var smCapPos = new Int16Array(n), smCapColor = new Int8Array(n);
    // Measured (150 ms, n=32, smart referee): smart terminal eval 48.4% vs
    // conservative 56.3% - the per-terminal capture search adds playout value
    // variance that is uncorrelated with the root move and hurts selection.
    // The conservative playout-eval is the better SEARCH prior even though
    // the real scorer is smart; smartDead stays available as an option (its
    // 1:1 page parity is verified by dev/smart-parity.js).
    var SMART_DEAD = opts.smartDead === true;
    // Static final-selection guards apply only below this search size;
    // deeper searches may legitimately prove a static-±0 move valuable.
    // 150 ms/move reaches ~4k root visits (guards on), 800 ms ~26k (off).
    var GUARD_MIN_VISITS = 16000;

    // Empty-region table (page regionInfo): per-point region id, per-region
    // border-colour mask and size.
    function smRegionScan(board) {
      var rid = 0, i, k, j, je, t, v, qn, s, mask;
      for (i = 0; i < n; i++) smRegId[i] = -1;
      for (i = 0; i < n; i++) {
        if (board[i] !== 0 || smRegId[i] >= 0) continue;
        qn = 0; smRegQueue[qn++] = i; smRegId[i] = rid; mask = 0;
        for (k = 0; k < qn; k++) {
          s = smRegQueue[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j]; v = board[t];
            if (v === 0) { if (smRegId[t] < 0) { smRegId[t] = rid; smRegQueue[qn++] = t; } }
            else mask |= (1 << v);
          }
        }
        smRegCols[rid] = mask; smRegSize[rid] = qn; rid++;
      }
      return rid;
    }

    // Page playStoneOnBoard on the sim board (mutating + undo on suicide).
    function smPlace(i, p) {
      if (smBoard[i] !== 0) return 0;
      smBoard[i] = p;
      var aid = ++applyId;
      var capN = 0, j, je, t, c, gi, k;
      for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) {
        t = nbFlat[j]; c = smBoard[t];
        if (c === 0 || c === p || applyStamp[t] === aid) continue;
        if (scanGroup(smBoard, t, c, 1) !== 0) continue;
        gi = grpN;
        for (k = 0; k < gi; k++) applyStamp[grpBuf[k]] = aid;
        for (k = 0; k < gi; k++) { smCapPos[capN] = grpBuf[k]; smCapColor[capN] = c; capN++; }
      }
      for (k = 0; k < capN; k++) smBoard[smCapPos[k]] = 0;
      scanGroup(smBoard, i, p, 1);
      if (lastLibs === 0) {
        smBoard[i] = 0;
        for (k = 0; k < capN; k++) smBoard[smCapPos[k]] = smCapColor[k];
        return 0;
      }
      return 1;
    }

    // Page canEnemyCaptureGroup: alternating enemy fills (any enemy colour,
    // adjacent colours first) until the group is captured or no enemy can
    // legally fill a liberty (alive / seki).  The group stones are in
    // smGrp[0..smGrpN-1]; smBoard holds the working copy.
    function canEnemyCaptureSim(color, pc) {
      var step, li, k, j, je, t, c, libs, gid, e, ci, dup;
      for (step = 0; step < 64; step++) {
        gid = ++smStampId; libs = 0;
        for (k = 0; k < smGrpN; k++) {
          var s = smGrp[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j];
            if (smBoard[t] === 0 && smStamp[t] !== gid) { smStamp[t] = gid; smLibs[libs++] = t; }
          }
        }
        if (libs === 0) return true;
        var moved = false;
        for (li = 0; li < libs && !moved; li++) {
          var l = smLibs[li];
          var colors = [];
          for (j = nbOff[l], je = nbOff[l + 1]; j < je; j++) {
            c = smBoard[nbFlat[j]];
            if (c !== 0 && c !== color) {
              dup = false;
              for (ci = 0; ci < colors.length; ci++) if (colors[ci] === c) { dup = true; break; }
              if (!dup) colors.push(c);
            }
          }
          for (e = 1; e <= pc; e++) {
            if (e === color) continue;
            dup = false;
            for (ci = 0; ci < colors.length; ci++) if (colors[ci] === e) { dup = true; break; }
            if (!dup) colors.push(e);
          }
          for (ci = 0; ci < colors.length; ci++) {
            if (!smPlace(l, colors[ci])) continue;
            if (smBoard[smGrp[0]] === 0) return true;      // target captured
            moved = true;
            break;
          }
        }
        if (!moved) return false;
      }
      return false;
    }

    // Faithful port of the page's detectDeadStonesSmart(): every group without
    // two eyes whose liberties all lie in small enemy-bordering regions gets
    // the alternating capture search; the result matches what the page will
    // actually remove at scoring.
    function removeDeadStonesSmart(board, pc) {
      if (!SMART_DEAD) { removeDeadStones(board); return; }
      removeDeadStonesSmartImpl(board, pc);
    }

    function removeDeadStonesSmartImpl(board, pc) {
      smRegionScan(board);
      dsSeenId++; dsDeadN = 0;
      var i, k, libN, gN, eyes, gid, enclosed, rid;
      for (i = 0; i < n; i++) {
        var color = board[i];
        if (color === 0 || dsSeen[i] === dsSeenId) continue;
        libN = scanGroupFull(board, i, color);
        gN = grpN;
        dsGroupId++;
        gid = dsGroupId;
        for (k = 0; k < gN; k++) { dsSeen[grpBuf[k]] = dsSeenId; dsGMark[grpBuf[k]] = gid; }
        if (libN === 0) continue;
        eyes = groupEyeCount(board, color, gid);
        if (eyes >= 2) continue;
        enclosed = true;
        for (k = 0; k < libN && enclosed; k++) {
          rid = smRegId[dsLibs[k]];
          if (rid < 0) { enclosed = false; break; }
          if (!(smRegCols[rid] & ~(1 << color))) { enclosed = false; break; }    // own-colour-only space: alive
          if (smRegSize[rid] > Math.max(6, gN * 2 + 2)) { enclosed = false; break; }
        }
        if (!enclosed) continue;
        smBoard.set(board);
        // Page group() discovery order (pop-DFS, NB order): the capture sim is
        // order-sensitive (which liberty gets filled first can decide
        // suicide-vs-capture), so the sim must iterate liberties exactly like
        // the page's canEnemyCaptureGroup.
        var dId = ++smStampId, stk = [];
        smGrpN = 0;
        smStamp[grpBuf[0]] = dId; smGrp[smGrpN++] = grpBuf[0]; stk.push(grpBuf[0]);
        while (stk.length) {
          var x2 = stk.pop();
          for (var j2 = nbOff[x2], je2 = nbOff[x2 + 1]; j2 < je2; j2++) {
            var t2 = nbFlat[j2];
            if (board[t2] === color && smStamp[t2] !== dId) { smStamp[t2] = dId; smGrp[smGrpN++] = t2; stk.push(t2); }
          }
        }
        if (canEnemyCaptureSim(color, pc)) {
          // smGrp is a private copy: grpBuf is clobbered by the sim's own
          // group scans, pushing from it would remove the wrong stones.
          for (k = 0; k < gN; k++) dsDead[dsDeadN++] = smGrp[k];
        }
      }
      for (k = 0; k < dsDeadN; k++) board[dsDead[k]] = 0;
    }

    // Exact page legality for one move on a scratch board (superko included).
    function simExactLegal(move, turn) {
      simBoard.set(srcBoard);
      capCount = 0;
      if (!applyMove(simBoard, move, turn)) return 0;
      var cc = lastCapEnd - lastCapStart;
      if (cc > 0 && seenSet !== null && seenSet.has(hashBoard(simBoard))) return 0;
      lastRootLibs = lastOwnLibs;
      return 1;
    }

    function genRootLegal(turn) {
      var list = [], i;
      for (i = 0; i < n; i++) {
        if (srcBoard[i] !== 0) continue;
        if (simExactLegal(i, turn)) {
          list.push(i);
          rootCap[i] = lastCapEnd - lastCapStart;
          // v2.1: exact liberty count of the resulting group (the applyMove scan
          // early-exits at 2, which clamps every viability test to "2").
          scanGroup(simBoard, i, turn, undefined);
          rootLibs[i] = lastLibs;
        } else { rootCap[i] = 0; rootLibs[i] = 0; }
      }
      capCount = 0;
      list.push(-1); // pass is always legal
      return list;
    }

    function countSavesAt(board, move, p) {
      var sid = ++saveId, cnt = 0;
      for (var j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        var s = nbFlat[j];
        if (board[s] !== p || saveStamp[s] === sid) continue;
        scanGroup(board, s, p, 2);
        var gi = grpN;
        for (var k = 0; k < gi; k++) saveStamp[grpBuf[k]] = sid;
        if (lastLibs === 1 && lastLibPt === move) cnt++;
      }
      return cnt;
    }

    // own groups adjacent to `move` that are down to <= 2 liberties and do NOT
    // already have 2 eyes: the move connects to / defends them.  A 2-eye living
    // group must never be marked as needing stabilization (otherwise its own
    // eyes look like "stabilizing moves" and bypass the eye-fill guard).
    function countStabAt(board, move, p) {
      var sid = ++saveId, cnt = 0;
      for (var j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        var s = nbFlat[j];
        if (board[s] !== p || saveStamp[s] === sid) continue;
        if (GAIN_POLICY && atkStamp[s] === atkId && atkEyes[s] >= 2) continue;
        scanGroup(board, s, p, 3);
        var gi = grpN;
        for (var k = 0; k < gi; k++) saveStamp[grpBuf[k]] = sid;
        if (lastLibs <= 2) cnt++;
      }
      return cnt;
    }

    // Ascending heuristic order; untried.pop() therefore tries the best move first.
    // v2: captures/saves + hex-shape patterns + opening framework priors +
    // endgame eye/own-territory penalties + diversity jitter.
    // Ascending heuristic order; untried.pop() therefore tries the best move first.
    // v2.1: gain policy orders by static score gain + attack bonus on weak enemy
    // groups (+ multiplayer leader weighting); legacy keeps the v2.0.0 ordering.
    function orderRootMoves(moves, turn, allowPass, passEnds, passGate) {
      var scored = [], mi, mv, sc, j, je, v, own, opp, save, eye, owner, dd, dOwn;
      var opening = stoneCountRoot <= Math.max(6, (n * 0.22) | 0);
      var endgame = emptyRoot <= n * 0.55;
      var inv;
      // Compute exact hex distance to nearest own stone for opening coherence
      rootOwnCount = 0;
      for (mi = 0; mi < n; mi++) if (srcBoard[mi] === turn) rootOwnCount++;
      if (opening && rootOwnCount > 0) {
        fillColorNear(srcBoard, turn, 8);
        for (mi = 0; mi < n; mi++) ownNear[mi] = enemyNear[mi];
      }
      var radius = geo.side - 1;
      for (mi = 0; mi < moves.length; mi++) {
        mv = moves[mi];
        if (mv === -1) {
          if (!allowPass) continue;
          sc = passEnds ? 1e7 : (passGate ? 1e6 : -1e9);
        } else {
          save = mvSave[mv];
          if (GAIN_POLICY) {
            sc = ownGain[mv] * GAIN_W + rootCap[mv] * 40 + save * 140 + atkB[mv] + rootPat[mv];
            inv = terrColorCount[mv] > 0 && !(terrColMask[mv] & (1 << turn));
          } else {
            sc = rootCap[mv] * 1000 + save * 140 + rootPat[mv];
          }
          own = 0; opp = 0;
          for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
            v = srcBoard[nbFlat[j]];
            if (v === turn) own++; else if (v !== 0) opp++;
          }
          sc += own * 4 + opp * 3;
          eye = ownEyeAt(srcBoard, mv, turn);
          owner = terrOwner[mv];
          if (eye && rootCap[mv] === 0) sc -= 900;
          var isOwnSettled = terrColorCount[mv] === 1 && (terrColMask[mv] & (1 << turn)) && rootCap[mv] === 0 && save === 0 && !mvStab[mv];
          if (isOwnSettled) sc -= 700;
          else if (owner === 0 && rootLibs[mv] >= 2) sc += 10;

          // Compute soft virtual prior (pn, pw) for root UCT/RAVE
          var pRate = 0.50, pN = 0;
          if (USE_PRIOR) {
            pN = 5;
            if (rootCap[mv] > 0) { pRate += 0.16; pN = 7; }
            if (save > 0) { pRate += 0.14; pN = 7; }
            if (rootPat[mv] >= 90) pRate += 0.10;
            else if (rootPat[mv] >= 55) pRate += 0.06;
            else if (rootPat[mv] >= 25) pRate += 0.02;
            if (atkB[mv] > 400) pRate += 0.06;
            if (rootLibs[mv] === 1 && rootCap[mv] === 0) { pRate = 0.15; pN = 8; }
            if (isOwnSettled && terrSize[mv] < V_MIN) { pRate = 0.12; pN = 8; }
            if (GAIN_POLICY && terrColorCount[mv] === 1 && !(terrColMask[mv] & (1 << turn)) && !mvViable[mv]) { pRate = 0.18; pN = 7; }
          }

          if (opening) {
            dd = nearestStoneDist(srcBoard, mv);
            var isEdge = nbMask[mv] !== FULL_MASK;
            var dc = geomDistCenter[mv];
            if (rootOwnCount === 0) {
              // First stone for this player: claim a strong framework point
              // (distance 2-3 from existing stones, avoid 1st-line edge)
              sc += dd >= 3 ? 42 : dd === 2 ? 32 : dd === 1 ? -12 : 0;
              if (USE_PRIOR) {
                if (dd === 2 || dd === 3) pRate += 0.09;
                else if (dd === 1 && stoneCountRoot <= 2) pRate -= 0.08;
                if (isEdge) pRate -= 0.16;
                // Prefer strong 3rd/4th-line or central-ring anchors
                if (!isEdge && dc >= Math.max(1, radius - 3) && dc <= Math.max(2, radius - 1)) pRate += 0.04;
              }
            } else {
              // Subsequent opening stones: build coherent living groups/moyo
              // (dist 2-3 from own stones), avoid scattering lone stones far away
              // into enemy zones (especially fatal in 3+ player games).
              dOwn = ownNear[mv];
              if (dOwn === 2) sc += 38;
              else if (dOwn === 3) sc += 34;
              else if (dOwn === 1) sc += 14;
              else if (dOwn === 4) sc += 8;
              else if (dOwn >= 5) sc -= (pcCur >= 3 ? 26 : 10);
              if (USE_PRIOR) {
                if (dOwn === 2 || dOwn === 3) pRate += 0.08;
                else if (dOwn === 1) pRate += 0.02;
                else if (dOwn >= 5 && dd <= 2) pRate -= (pcCur >= 3 ? 0.15 : 0.08);
                else if (dOwn >= 5 && pcCur >= 3) pRate -= 0.08;
                if (isEdge) pRate -= 0.14;
              }
            }
            sc += (n - dc) * (pcCur >= 3 ? 0.10 : 0.20);
            if (pcCur >= 3 && dc >= (geo.size - 1) * 0.35 && !isEdge) sc += 16;
            if (isEdge) sc -= 32;
            sc += rng() * 45;
          } else if (endgame) {
            sc += rng() * 4;
          } else {
            sc += rng() * 10;
          }
          if (pRate < 0.05) pRate = 0.05;
          if (pRate > 0.88) pRate = 0.88;
          rootPriorN[mv] = pN;
          rootPriorW[mv] = pN * pRate;
        }
        scored.push([sc, mv]);
      }
      scored.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      var out = new Array(scored.length);
      for (mi = 0; mi < scored.length; mi++) out[mi] = scored[mi][1];
      if (out.length === 0) out.push(-1);
      return out;
    }

    /* ================================================================== *
     *  Rollout ("playout") policy — O(1) incremental pseudo-liberty chains
     * ================================================================== */

    var pboard = new Int8Array(n);
    var empList = new Int16Array(n), empPos = new Int16Array(n), empCount = 0;
    // Incremental chain state (valid during a playout):
    // A chain h is in exact atari iff cLibCnt[h] > 0 && cLibCnt[h]*cLibSq[h] === cLibSum[h]*cLibSum[h]
    // (Cauchy-Schwarz equality => all pseudo-liberties are the single point cLibSum[h]/cLibCnt[h]).
    var cHead = new Int16Array(n), cNext = new Int16Array(n), cSize = new Int16Array(n);
    var cLibCnt = new Int32Array(n);
    var cLibSum = new Float64Array(n), cLibSq = new Float64Array(n);
    var pCapHeads = new Int16Array(8);
    var pCapList = new Int16Array(n);
    var pOwnH = new Int16Array(8);
    var atariList = new Int16Array(n * 4 + 64), atariCount = 0;
    var stoneCnt = new Int16Array(8);
    var plyKo = -1, plyPasses = 0, plyMover = 0;
    var plyLastMove = -1, plyPrevMove = -1;
    var rng = mulberry32(1);
    var amafMark = new Int32Array(n), amafWho = new Int8Array(n), amafStamp = 0;
    // LGRF-1 (Last Good Reply with Forgetting): per-player reply to last move.
    var USE_LGR = opts.useLgr !== false;
    var USE_LOCAL_PAT = opts.useLocalPat !== false;
    var lgrTable = new Int16Array(8 * n);
    var plyHistP = new Int8Array(MAX_PLAYOUT_STEPS + 4);
    var plyHistPrev = new Int16Array(MAX_PLAYOUT_STEPS + 4);
    var plyHistMv = new Int16Array(MAX_PLAYOUT_STEPS + 4);
    var plyHistLen = 0;

    function addEmpty(e) {
      empPos[e] = empCount;
      empList[empCount++] = e;
    }

    function removeEmpty(e) {
      var pos = empPos[e];
      var last = empList[--empCount];
      empList[pos] = last;
      empPos[last] = pos;
    }

    function isOwnEye(e, p) {
      for (var j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (pboard[nbFlat[j]] !== p) return 0;
      return 1;
    }

    // Build incremental chain tables from pboard once at playout start (O(n)).
    function playInitChains() {
      var i, j, je, t, v, s, k, gi, cnt, sum, sq;
      empCount = 0;
      atariCount = 0;
      for (i = 1; i <= pcCur; i++) stoneCnt[i] = 0;
      for (i = 0; i < n; i++) {
        cHead[i] = -1;
        v = pboard[i];
        if (v === 0) { empPos[i] = empCount; empList[empCount++] = i; }
        else stoneCnt[v]++;
      }
      for (i = 0; i < n; i++) {
        v = pboard[i];
        if (v === 0 || cHead[i] >= 0) continue;
        // Flood-fill initial chain into grpBuf
        grpN = 0;
        grpBuf[grpN++] = i;
        cHead[i] = i;
        cnt = 0; sum = 0; sq = 0;
        for (k = 0; k < grpN; k++) {
          s = grpBuf[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j];
            if (pboard[t] === v) {
              if (cHead[t] < 0) { cHead[t] = i; grpBuf[grpN++] = t; }
            } else if (pboard[t] === 0) {
              cnt++; sum += t; sq += t * t;
            }
          }
        }
        gi = grpN;
        for (k = 0; k < gi - 1; k++) cNext[grpBuf[k]] = grpBuf[k + 1];
        cNext[grpBuf[gi - 1]] = i;
        cSize[i] = gi;
        cLibCnt[i] = cnt; cLibSum[i] = sum; cLibSq[i] = sq;
        if (cnt > 0 && cnt * sq === sum * sum && atariCount < atariList.length) atariList[atariCount++] = i;
      }
    }

    // Non-mutating O(degree) check for playing colour `p` at empty point `e`:
    //   0 = illegal (occupied / ko / suicide)
    //   1 = legal and safe (>= 2 liberties, no capture)
    //   2 = legal but self-atari (1 liberty, no capture)
    //   3 = legal and captures at least one enemy chain
    function checkPlayMove(e, p) {
      if (pboard[e] !== 0 || e === plyKo) return 0;
      var j, je, t, c, h, k, dup;
      var eEmpty = 0, eEmptySum = 0, eEmptySq = 0;
      var ownAdj = 0, ownHN = 0, totCnt = 0, totSum = 0, totSq = 0;
      var anyCap = 0;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        t = nbFlat[j]; c = pboard[t];
        if (c === 0) {
          eEmpty++; eEmptySum += t; eEmptySq += t * t;
        } else if (c === p) {
          ownAdj++;
          h = cHead[t];
          dup = 0;
          for (k = 0; k < ownHN; k++) if (pOwnH[k] === h) { dup = 1; break; }
          if (!dup) {
            pOwnH[ownHN++] = h;
            totCnt += cLibCnt[h]; totSum += cLibSum[h]; totSq += cLibSq[h];
          }
        } else {
          h = cHead[t];
          var lc = cLibCnt[h];
          if (lc > 0 && lc * cLibSq[h] === cLibSum[h] * cLibSum[h] && cLibSum[h] === lc * e) anyCap = 1;
        }
      }
      if (anyCap) return 3;
      totCnt += eEmpty - ownAdj;
      if (totCnt <= 0) return 0; // suicide
      totSum += eEmptySum - ownAdj * e;
      totSq += eEmptySq - ownAdj * e * e;
      if (totCnt * totSq === totSum * totSum) return 2; // self-atari
      return 1;
    }

    // Commit a move already verified legal by checkPlayMove(e, p).
    function playCommit(e, p) {
      var eSq = e * e;
      var j, je, t, c, h, k, s, u, hu, capHN = 0, capLN = 0;
      pboard[e] = p;
      removeEmpty(e);
      stoneCnt[p]++;
      cHead[e] = e; cNext[e] = e; cSize[e] = 1;
      var ecnt = 0, esum = 0, esq = 0;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        t = nbFlat[j]; c = pboard[t];
        if (c === 0) {
          ecnt++; esum += t; esq += t * t;
        } else {
          h = cHead[t];
          cLibCnt[h]--; cLibSum[h] -= e; cLibSq[h] -= eSq;
          if (c !== p && cLibCnt[h] === 0) {
            var dup = 0;
            for (k = 0; k < capHN; k++) if (pCapHeads[k] === h) { dup = 1; break; }
            if (!dup) pCapHeads[capHN++] = h;
          }
        }
      }
      cLibCnt[e] = ecnt; cLibSum[e] = esum; cLibSq[e] = esq;

      // Capture all dead enemy chains simultaneously (safe for multi-chain captures).
      if (capHN > 0) {
        for (k = 0; k < capHN; k++) {
          h = pCapHeads[k];
          var capCol = pboard[h];
          s = h;
          do {
            pboard[s] = 0; cHead[s] = -1;
            addEmpty(s);
            stoneCnt[capCol]--;
            pCapList[capLN++] = s;
            s = cNext[s];
          } while (s !== h);
        }
        for (k = 0; k < capLN; k++) {
          s = pCapList[k];
          var sSq = s * s;
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            u = nbFlat[j];
            if (pboard[u] !== 0) {
              hu = cHead[u];
              cLibCnt[hu]++; cLibSum[hu] += s; cLibSq[hu] += sSq;
            }
          }
        }
      }

      // Record any surviving enemy neighbour chains now in atari.
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        t = nbFlat[j]; c = pboard[t];
        if (c !== 0 && c !== p) {
          h = cHead[t];
          var lc = cLibCnt[h];
          if (lc > 0 && lc * cLibSq[h] === cLibSum[h] * cLibSum[h] && atariCount < atariList.length) atariList[atariCount++] = h;
        }
      }

      // Merge `e` with all adjacent own chains (small into large).
      var eh = e;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        t = nbFlat[j];
        if (pboard[t] !== p) continue;
        h = cHead[t];
        if (h === eh) continue;
        var big = cSize[eh] >= cSize[h] ? eh : h;
        var sml = big === eh ? h : eh;
        s = sml;
        do { cHead[s] = big; s = cNext[s]; } while (s !== sml);
        var tmp = cNext[big]; cNext[big] = cNext[sml]; cNext[sml] = tmp;
        cSize[big] += cSize[sml];
        cLibCnt[big] += cLibCnt[sml]; cLibSum[big] += cLibSum[sml]; cLibSq[big] += cLibSq[sml];
        eh = big;
      }
      var elc = cLibCnt[eh];
      if (elc > 0 && elc * cLibSq[eh] === cLibSum[eh] * cLibSum[eh] && atariCount < atariList.length) atariList[atariCount++] = eh;

      if (amafMark[e] !== amafStamp) { amafMark[e] = amafStamp; amafWho[e] = p; }
      if (USE_LGR && plyLastMove >= 0 && plyHistLen < MAX_PLAYOUT_STEPS) {
        plyHistP[plyHistLen] = p;
        plyHistPrev[plyHistLen] = plyLastMove;
        plyHistMv[plyHistLen] = e;
        plyHistLen++;
      }
      plyKo = capLN === 1 ? pCapList[0] : -1;
      plyPrevMove = plyLastMove;
      plyLastMove = e;
    }

    function tryAccept(p, e, allowSelfAtariProb) {
      var st = checkPlayMove(e, p);
      if (st === 0) return 0;
      if (st === 2 && (allowSelfAtariProb === 0 || rng() < SELF_ATARI_REJECT)) return 0;
      playCommit(e, p);
      return 1;
    }

    // Fast local hex-pattern score inside playouts (lightweight subset of patternScore).
    function playLocalScore(e, p) {
      var j, je, v, d, ownM = 0, enM = 0;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        v = pboard[nbFlat[j]];
        if (v === 0) continue;
        d = nbDirFlat[j];
        if (v === p) ownM |= 1 << d; else enM |= 1 << d;
      }
      if (nbMask[e] !== 0 && ownM === nbMask[e]) return -100;
      var sc = 0, m, m2, b1, b2, dd;
      m = ownM;
      while (m) {
        b1 = m & -m; m ^= b1; m2 = m;
        while (m2) {
          b2 = m2 & -m2; m2 ^= b2;
          dd = cycDiff(BITIDX[b1], BITIDX[b2]);
          if (dd === 2) sc += 30; else if (dd === 3) sc += 18;
        }
      }
      m = enM;
      while (m) {
        b1 = m & -m; m ^= b1; m2 = m;
        while (m2) {
          b2 = m2 & -m2; m2 ^= b2;
          dd = cycDiff(BITIDX[b1], BITIDX[b2]);
          if (dd === 3) sc += 24; else if (dd === 2) sc += 12;
        }
      }
      return sc;
    }

    // One rollout turn. Returns 1 if a stone was placed, 0 if passing.
    // O(1) incremental chain policy:
    //  1) Local atari capture / save around last move (counter-atari first)
    //  2) Global atari capture / save from incremental atariList
    //  3) LGRF-1 reply to last move
    //  4) Local hex-pattern reply around last move
    //  5) Random local empty point (avoids own eyes and self-atari)
    function playoutTurn(p) {
      var j, je, t, c, h, lc, lp, k, s, u, j2, je2, uh;
      var bestCap = -1, bestCapSz = 0, bestSave = -1, bestSaveSz = 0;

      // 1. Local tactical check around plyLastMove (fast path)
      var lm = plyLastMove;
      if (lm >= 0 && pboard[lm] !== 0) {
        var lh = cHead[lm];
        if (pboard[lm] !== p) {
          lc = cLibCnt[lh];
          if (lc > 0 && lc * cLibSq[lh] === cLibSum[lh] * cLibSum[lh]) {
            lp = (cLibSum[lh] / lc) | 0;
            if (cSize[lh] > bestCapSz && checkPlayMove(lp, p) === 3) { bestCap = lp; bestCapSz = cSize[lh]; }
          }
        }
        for (j = nbOff[lm], je = nbOff[lm + 1]; j < je; j++) {
          t = nbFlat[j]; c = pboard[t];
          if (c === 0) continue;
          h = cHead[t];
          lc = cLibCnt[h];
          if (lc <= 0 || lc * cLibSq[h] !== cLibSum[h] * cLibSum[h]) continue;
          lp = (cLibSum[h] / lc) | 0;
          if (c === p) {
            if (cSize[h] > bestSaveSz) {
              // Prefer counter-capturing an adjacent enemy chain in atari if one exists
              var stSave = checkPlayMove(lp, p);
              if (stSave === 1 || stSave === 3) { bestSave = lp; bestSaveSz = cSize[h]; }
            }
          } else {
            if (cSize[h] > bestCapSz && checkPlayMove(lp, p) === 3) { bestCap = lp; bestCapSz = cSize[h]; }
          }
        }
      }

      // 2. Scan and compact incremental atariList (keeps global tactical sharpness in O(atari))
      var w = 0;
      for (k = 0; k < atariCount; k++) {
        h = atariList[k];
        c = pboard[h];
        if (c === 0 || cHead[h] !== h) continue;
        lc = cLibCnt[h];
        if (lc <= 0 || lc * cLibSq[h] !== cLibSum[h] * cLibSum[h]) continue;
        atariList[w++] = h;
        lp = (cLibSum[h] / lc) | 0;
        if (c === p) {
          if (cSize[h] > bestSaveSz) {
            var stS = checkPlayMove(lp, p);
            if (stS === 1 || stS === 3) { bestSave = lp; bestSaveSz = cSize[h]; }
          }
        } else {
          if (cSize[h] > bestCapSz && checkPlayMove(lp, p) === 3) { bestCap = lp; bestCapSz = cSize[h]; }
        }
      }
      atariCount = w;

      if (bestCap >= 0 && rng() < 0.90) { playCommit(bestCap, p); return 1; }
      if (bestSave >= 0 && rng() < 0.92) { playCommit(bestSave, p); return 1; }

      // 3. LGRF-1: try last winning reply to plyLastMove
      if (USE_LGR && lm >= 0) {
        var lmv = lgrTable[p * n + lm];
        if (lmv >= 0 && pboard[lmv] === 0 && !isOwnEye(lmv, p)) {
          var stL = checkPlayMove(lmv, p);
          if (stL === 1 || stL === 3) {
            playCommit(lmv, p);
            return 1;
          }
        }
      }

      // 4. Local hex-pattern response around plyLastMove
      if (USE_LOCAL_PAT && lm >= 0 && rng() < 0.55) {
        var bestPatMv = -1, bestPatSc = 11;
        for (j = nbOff[lm], je = nbOff[lm + 1]; j < je; j++) {
          t = nbFlat[j];
          if (pboard[t] !== 0) continue;
          var psc = playLocalScore(t, p);
          if (psc > bestPatSc) {
            var stP = checkPlayMove(t, p);
            if (stP === 1 || stP === 3) { bestPatSc = psc; bestPatMv = t; }
          }
        }
        if (bestPatMv >= 0) { playCommit(bestPatMv, p); return 1; }
      }

      // 5. Random empty point (fast O(1) sampling from empList; prefers points near stones)
      if (empCount > 0) {
        var a, e, tries = empCount < 12 ? empCount : 12;
        for (a = 0; a < tries; a++) {
          e = empList[(rng() * empCount) | 0];
          if (isOwnEye(e, p)) continue;
          // Prefer local play (adjacent to at least one stone) when stones exist
          var adj = 0;
          for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (pboard[nbFlat[j]] !== 0) { adj = 1; break; }
          if (!adj && a < 8) continue;
          if (tryAccept(p, e, 1)) return 1;
        }
        // Fallback linear scan from random start so we never miss a legal non-eye move
        var off = (rng() * empCount) | 0;
        for (a = 0; a < empCount; a++) {
          e = empList[(off + a) % empCount];
          if (isOwnEye(e, p)) continue;
          if (tryAccept(p, e, 1)) return 1;
        }
      }
      return 0;
    }

    function runPlayout(startMover, startKo, startPasses) {
      pboard.set(treeBoard);
      playInitChains();
      plyKo = startKo; plyPasses = startPasses; plyMover = startMover;
      plyLastMove = -1; plyPrevMove = -1;
      plyHistLen = 0;
      var maxSteps = MAX_PLAYOUT_STEPS;
      for (var step = 0; step < maxSteps; step++) {
        var played = playoutTurn(plyMover);
        if (played === 0) { plyPasses++; plyKo = -1; plyLastMove = -1; plyPrevMove = -1; }
        else { plyPasses = 0; }
        if (plyPasses >= activeCount) break;
        var t2 = plyMover;
        do { t2 = (t2 % pcCur) + 1; } while (outFlags[t2]);
        plyMover = t2;
      }
      removeDeadStonesSmart(pboard, pcCur);
      scoreBoardInto(pboard, outSc, pcCur);
    }

    function computeOutcome() {
      var p, o, best, s, v;
      for (p = 1; p <= pcCur; p++) {
        if (outFlags[p]) { winArr[p] = 0; valArr[p] = 0; continue; }
        best = -32768;
        for (o = 1; o <= pcCur; o++) {
          if (o === p || outFlags[o]) continue;
          s = outSc[o];
          if (s > best) best = s;
        }
        if (best === -32768) best = outSc[p];
        s = outSc[p];
        winArr[p] = s > best ? 1 : (s === best ? 0.5 : 0);
        v = (s - best) / n;
        valArr[p] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
      // Multiplayer: blend rank-1 probability with the score margin so a seat
      // that cannot win still prefers to improve its rank / hurt the leader
      // (kingmaking awareness) instead of playing randomly.
      // 2P: small score-margin blend keeps winning/losing positions sharp.
      if (pcCur >= 3) {
        for (p = 1; p <= pcCur; p++) {
          if (outFlags[p]) continue;
          winArr[p] = winArr[p] * RANK_BLEND + (valArr[p] * 0.5 + 0.5) * (1 - RANK_BLEND);
        }
      } else if (MARGIN_2P > 0) {
        for (p = 1; p <= pcCur; p++) {
          if (outFlags[p]) continue;
          winArr[p] = winArr[p] * (1 - MARGIN_2P) + (valArr[p] * 0.5 + 0.5) * MARGIN_2P;
        }
      }
    }

    /* ================================================================== *
     *  MCTS
     * ================================================================== */

    function makeNode(mover, move, parent, depth, passes, ko) {
      return {
        mover: mover, move: move, parent: parent, depth: depth,
        passes: passes, ko: ko,
        n: 0, w: 0, v: 0, rn: 0, rw: 0,
        pn: 0, pw: 0,
        children: null, untried: null,
        terminal: false, termScores: null
      };
    }

    var histMove = new Int16Array(MAX_DEPTH + 8);
    var histCapStart = new Int32Array(MAX_DEPTH + 8);
    var histCapEnd = new Int32Array(MAX_DEPTH + 8);
    var histLen = 0;

    // Tree expansion candidates: local tactical moves (pattern-ordered) PLUS
    // global/framework candidates (strategic anchors and distant empty points),
    // so the tree never becomes purely adjacent-move-only.
    function buildUntried(mover, relDepth) {
      var i, j, je, v, ownN, enN, adj, e, t;
      var hi = [], mid = [], lo = [], glob = [];
      for (i = 0; i < n; i++) {
        if (treeBoard[i] !== 0) continue;
        ownN = 0; enN = 0; adj = 0;
        for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) {
          v = treeBoard[nbFlat[j]];
          if (v === 0) continue;
          adj = 1;
          if (v === mover) ownN++; else enN++;
        }
        if (!adj) continue;
        if (ownN >= 3 || enN >= 3) hi.push(i);
        else if (ownN >= 2 || enN >= 2) {
          if (patternScore(treeBoard, i, mover) >= 58) hi.push(i); else mid.push(i);
        } else if (ownN >= 1) mid.push(i);
        else lo.push(i);
      }
      // shuffle each bucket, then concat low->high so pop() tries strong moves first
      function shuf(a) { for (var q = a.length - 1; q > 0; q--) { var kq = (rng() * (q + 1)) | 0; var tv = a[q]; a[q] = a[kq]; a[kq] = tv; } }
      shuf(lo); shuf(mid); shuf(hi);
      var arr = lo;
      for (i = 0; i < mid.length; i++) arr.push(mid[i]);
      for (i = 0; i < hi.length; i++) arr.push(hi[i]);
      // global / distant candidates only in the first plies below the root,
      // otherwise the branching factor explodes and high-budget search degrades
      if (relDepth <= 2) {
        for (i = 0; i < globalCount; i++) {
          e = globalCand[i];
          if (treeBoard[e] !== 0) continue;
          adj = 0;
          for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (treeBoard[nbFlat[j]] !== 0) { adj = 1; break; }
          if (adj) continue;
          glob.push(e);
        }
        shuf(glob);
        for (i = 0; i < glob.length && i < 8; i++) arr.push(glob[i]);
        // v2.1: liberties of weak enemy groups (<= 3 libs, < 2 eyes) as attack
        // candidates.  Measured weaker at equal budget (see notes 11), so this
        // is opt-in (opts.treeAtk); the root ordering/bias covers attacks.
        if (ATK_ORDER && TREE_ATK) {
          var atkPts = [], found;
          dsSeenId++;
          for (i = 0; i < n; i++) {
            var ac = treeBoard[i];
            if (ac === 0 || ac === mover || dsSeen[i] === dsSeenId) continue;
            var alibs = scanGroupFull(treeBoard, i, ac);
            var agi = grpN, agid = ++dsGroupId, k2;
            for (k2 = 0; k2 < agi; k2++) { dsSeen[grpBuf[k2]] = dsSeenId; dsGMark[grpBuf[k2]] = agid; }
            if (alibs > 3) continue;
            if (groupEyeCount(treeBoard, ac, agid) >= 2) continue;
            for (k2 = 0; k2 < alibs && atkPts.length < 10; k2++) {
              var alp = dsLibs[k2];
              if (treeBoard[alp] !== 0) continue;
              found = 0;
              for (var ai3 = 0; ai3 < arr.length; ai3++) { if (arr[ai3] === alp) { found = 1; break; } }
              if (!found) atkPts.push(alp);
            }
          }
          shuf(atkPts);
          for (i = 0; i < atkPts.length; i++) arr.push(atkPts[i]);
        }
      }
      // pass
      arr.push(-1);
      if (arr.length > 1) {
        var pi = (rng() * arr.length) | 0;
        var tmp = arr[pi]; arr[pi] = arr[arr.length - 1]; arr[arr.length - 1] = tmp;
      }
      return arr;
    }

    function selectUCT(node, isRoot) {
      var kids = node.children, ln = Math.log(node.n + 1);
      var best = kids[0], bestV = -1e18;
      var rb2 = 4 * RAVE_B * RAVE_B;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.n <= 0) { return ch; }
        // ch.w / ch.rw are accumulated for the mover of `node` (the parent).
        var pn = isRoot ? ch.pn : 0;
        var wn = ch.n + pn;
        var q = (ch.w + (isRoot ? ch.pw : 0)) / wn;
        if (ch.rn > 0) {
          // MoGo-style RAVE weight: conservative early, decaying with visits.
          var rn = ch.rn;
          var beta = rn / (rn + wn + wn * rn * rb2);
          q = (1 - beta) * q + beta * (ch.rw / rn);
        }
        var v = q + curC * Math.sqrt(ln / ch.n);
        if (isRoot && ch.move >= 0 && atkB[ch.move] > 2000) {
          v += Math.max(0, 1.2 - 0.025 * ch.n);
        }
        if (v > bestV) { bestV = v; best = ch; }
      }
      return best;
    }

    function terminalScores(board) {
      dsBoard.set(board);
      removeDeadStonesSmart(dsBoard, pcCur);
      scoreBoardInto(dsBoard, scoreScratch, pcCur);
      var t = new Int16Array(pcCur + 1);
      t.set(scoreScratch.subarray(0, pcCur + 1));
      return t;
    }

    function resetStampsIfNeeded() {
      if (scanId > 1000000000) { scanStamp.fill(0); scanId = 0; }
      if (libId > 1000000000) { libStamp.fill(0); libId = 0; }
      if (applyId > 1000000000) { applyStamp.fill(0); applyId = 0; }
      if (saveId > 1000000000) { saveStamp.fill(0); saveId = 0; }
      if (regId > 1000000000) { regStamp.fill(0); regId = 0; }
    }

    /* ------------------------------------------------------------------ *
     *  Public: root legal moves / scoring (used by tests and by think)
     * ------------------------------------------------------------------ */

    function prepareState(state) {
      var boardIn = state && state.board;
      if (!boardIn || boardIn.length !== n) throw new Error('HEXAGO engine: board length mismatch (expected ' + n + ')');
      var pc = state.playerCount | 0;
      if (pc < 2) pc = engPC;
      if (pc > 6) pc = 6;
      pcCur = pc;
      var p;
      for (p = 1; p <= pc; p++) outFlags[p] = state.out && state.out[p] ? 1 : 0;
      for (p = pc + 1; p <= 7; p++) outFlags[p] = 0;
      activeCount = 0;
      for (p = 1; p <= pc; p++) if (!outFlags[p]) activeCount++;
      var seenSrc = state.seen;
      if (seenSrc && seenSrc.length) {
        if (seenSrc instanceof Set) seenSet = seenSrc;
        else { seenSet = new Set(); for (var si = 0; si < seenSrc.length; si++) seenSet.add(seenSrc[si]); }
      } else seenSet = null;
      var i;
      for (i = 0; i < n; i++) srcBoard[i] = boardIn[i] !== undefined ? boardIn[i] : 0;
      rootMover = state.turn | 0;
      if (rootMover < 1 || rootMover > pc) rootMover = 1;
      return pc;
    }

    function rootLegalMovesImpl(state) {
      resetStampsIfNeeded();
      prepareState(state);
      capCount = 0;
      return genRootLegal(rootMover);
    }

    function scoreBoardImpl(board, pc) {
      var out = new Array((pc | 0) + 1);
      scoreBoardInto(board, out, pc | 0);
      return out;
    }

    /* ------------------------------------------------------------------ *
     *  think()
     * ------------------------------------------------------------------ */

    function think(state, options) {
      resetStampsIfNeeded();
      options = options || {};
      var start = nowMs();
      var pc = prepareState(state);
      var turn = rootMover;
      var passes = state.passes | 0;
      var budgetMs = options.budgetMs == null ? DEFAULT_BUDGET_MS : Math.max(1, +options.budgetMs || 1);
      var maxPlayouts = (options.maxPlayouts == null || options.maxPlayouts < 0) ? -1 : (options.maxPlayouts | 0);
      var timeLimited = maxPlayouts < 0;
      var seed = options.seed == null ? ((Math.random() * 4294967296) | 0) : (options.seed | 0);
      rng = mulberry32(seed);

      // Terminal / single-active situations: nothing to search.
      if (activeCount <= 1 || passes >= activeCount) {
        return {
          move: -1, visits: 0, playouts: 0, winrate: 0, value: 0,
          bestMoves: [], elapsedMs: nowMs() - start, engine: VERSION
        };
      }

      capCount = 0;
      var i;
      emptyRoot = 0; stoneCountRoot = 0;
      for (i = 0; i < n; i++) { if (srcBoard[i] === 0) emptyRoot++; else stoneCountRoot++; }
      curC = UCT_C;

      // Fresh exact root legality (page rules: occupied / suicide / superko-on-capture).
      var legal = genRootLegal(turn);
      var legalMark = new Uint8Array(n);
      for (i = 0; i < legal.length; i++) if (legal[i] >= 0) legalMark[legal[i]] = 1;
      buildGlobalCandidates();
      var noUseful = classifyRootMoves(legal, turn);
      var passEnds = passes + 1 >= activeCount;

      // First-class pass (v2.1 gain policy): the engine passes exactly when
      // nobody's score can move any more - no own gain AND no opponent threat
      // (dame left / our regions invadable / our groups weak).  It never passes
      // while dame or profitable plays remain, and never fills instead.
      var passGate = GAIN_POLICY ? (noUsefulRoot && !enemyThreat) : noUsefulRoot;
      var allowPass = passEnds || passGate || legal.length <= 1;

      // Root search candidates: exclude ALL provably hopeless moves (own eyes,
      // immediately smart-dead placements, dead invasions into living enemy
      // pockets, trapped dead-stone piling, and useless fills inside safe own
      // territory) unconditionally so neither 1 worker nor 8-worker pool merges
      // can ever select them at any time budget.
      var candMoves = [];
      if (GAIN_POLICY && RESTRICT_CAND) {
        for (i = 0; i < legal.length; i++) {
          if (legal[i] >= 0 && mvUseful[legal[i]] && !mvHopeless[legal[i]]) candMoves.push(legal[i]);
        }
        if (candMoves.length === 0) {
          for (i = 0; i < legal.length; i++) {
            var fm = legal[i];
            if (fm < 0 || mvHopeless[fm]) continue;
            if (rootLibs[fm] === 1 && rootCap[fm] === 0) continue;
            candMoves.push(fm);
          }
        }
      } else {
        for (i = 0; i < legal.length; i++) {
          var lm0 = legal[i];
          if (lm0 >= 0 && GAIN_POLICY && mvHopeless[lm0]) continue;
          if (lm0 >= 0 && rootCap[lm0] === 0 && ownEyeAt(srcBoard, lm0, turn)) continue;
          candMoves.push(lm0);
        }
      }
      var hasBoardCand = false;
      var candMark = new Uint8Array(n);
      for (i = 0; i < candMoves.length; i++) if (candMoves[i] >= 0) { candMark[candMoves[i]] = 1; hasBoardCand = true; }
      // If EVERY legal board placement is hopeless (only eyes, settled small own
      // territory, or dead invasions remain), passing immediately is exact.
      if (GAIN_POLICY && !hasBoardCand) { passGate = true; allowPass = true; }
      if (allowPass && candMoves[candMoves.length - 1] !== -1) candMoves.push(-1);

      // The position is frozen for everyone: passing is the correct decision
      // (instant, zero playouts - this is where the endgame time budget goes).
      if (passGate) {
        simBoard.set(srcBoard);
        capCount = 0;
        removeDeadStonesSmartImpl(simBoard, pc);
        scoreBoardInto(simBoard, outSc, pc);
        computeOutcome();
        var passVal = winArr[rootMover], passScore = valArr[rootMover];
        var resignHere = -1;
        if (options.resignThreshold != null && pc === 2 && passVal < +options.resignThreshold && passScore < -0.35) resignHere = -2;
        return {
          move: resignHere, visits: 0, playouts: 0,
          winrate: passVal, value: passScore,
          bestMoves: [{ move: -1, visits: 1, value: passVal }],
          rootMoves: [{ move: -1, visits: 1, winrate: passVal, value: passScore }],
          elapsedMs: nowMs() - start, engine: VERSION
        };
      }

      var root = null;
      var oldRoot = engine._root;
      var outSig = 0;
      for (i = 1; i <= pc; i++) if (outFlags[i]) outSig |= (1 << i);

      // ---- Multi-ply tree reuse: search oldRoot up to `activeCount` plies deep
      // so tree reuse works in real 2P (depth 2) and 3P..6P (depth 3..6) games
      // where each seat calls think() only on its own turn.
      if (TREE_REUSE && oldRoot && oldRoot.children && oldRoot.children.length && oldRoot.pc === pc && oldRoot.outSig === outSig && oldRoot.boardCopy) {
        var maxReuseDepth = Math.min(activeCount, 4);
        var reuseBudget = 300;
        var reuseBoard = cmpBoard;
        reuseBoard.set(oldRoot.boardCopy);
        var findReuse = function (curNode, depth) {
          if (root !== null || reuseBudget <= 0) return;
          var chs = curNode.children;
          if (!chs || !chs.length) return;
          // Visit highest-visit children first (most likely played line)
          var ord = chs.length <= 1 ? chs : chs.slice().sort(function (a, b) { return b.n - a.n; });
          for (var ci = 0; ci < ord.length && root === null && reuseBudget > 0; ci++) {
            var ch = ord[ci];
            if (ch.n <= 0) continue;
            reuseBudget--;
            var hsR = capCount, okR = 1;
            if (ch.move >= 0) {
              if (reuseBoard[ch.move] !== 0) continue;
              okR = applyMove(reuseBoard, ch.move, curNode.mover);
              if (!okR) { capCount = hsR; continue; }
            }
            var endR = capCount;
            if (ch.mover === turn && ch.passes === passes) {
              var eq = 1;
              for (var bi = 0; bi < n; bi++) { if (reuseBoard[bi] !== srcBoard[bi]) { eq = 0; break; } }
              if (eq) {
                var kids = ch.children;
                if (kids) {
                  for (var ki = 0; ki < kids.length; ki++) {
                    var km = kids[ki].move;
                    if (km !== -1 && !legalMark[km]) { eq = 0; break; }
                  }
                }
                if (eq) root = ch;
              }
            }
            if (root === null && depth < maxReuseDepth && ch.children && ch.children.length) {
              findReuse(ch, depth + 1);
            }
            if (ch.move >= 0) undoMove(reuseBoard, ch.move, hsR, endR);
            else capCount = hsR;
          }
        };
        capCount = 0;
        findReuse(oldRoot, 1);
        capCount = 0;
      }

      if (root) {
        root.parent = null;
        root.terminal = false;
        root.termScores = null;
        root.ko = -1; // root legality is exact (superko), not simple ko
        root.passes = passes;
        root.boardCopy = new Int8Array(n); root.boardCopy.set(srcBoard);
        root.pc = pc; root.outSig = outSig;
        // v2.1: drop children that are no longer search candidates at this
        // position (own-territory fills, dead invasions) before recomputing.
        if (GAIN_POLICY && root.children && root.children.length) {
          var keptKids = [];
          for (var pk = 0; pk < root.children.length; pk++) {
            var kc = root.children[pk];
            if (kc.move >= 0 && !candMark[kc.move]) continue;
            keptKids.push(kc);
          }
          root.children = keptKids;
        }
        // The adopted node's own w/n were accumulated for its OLD parent's
        // perspective; recompute root stats from its children, whose stats are
        // already from the new root mover's perspective and stay valid.
        root.n = 0; root.w = 0; root.v = 0;
        if (root.children) {
          for (var rc = 0; rc < root.children.length; rc++) {
            root.n += root.children[rc].n;
            root.w += root.children[rc].w;
            root.v += root.children[rc].v;
          }
        }
        // Rebuild the untried list: candidate moves not already expanded.
        var childMark = new Uint8Array(n);
        var kidsNow = root.children || [];
        for (i = 0; i < kidsNow.length; i++) if (kidsNow[i].move >= 0) childMark[kidsNow[i].move] = 1;
        var ordered = orderRootMoves(candMoves, turn, allowPass, passEnds, passGate);
        var untried = [];
        for (i = 0; i < ordered.length; i++) { if (ordered[i] === -1 || !childMark[ordered[i]]) untried.push(ordered[i]); }
        // Refresh virtual priors on adopted root children for the new position
        if (root.children) {
          for (i = 0; i < root.children.length; i++) {
            var rch = root.children[i];
            if (rch.move >= 0) { rch.pn = rootPriorN[rch.move]; rch.pw = rootPriorW[rch.move]; }
            else { rch.pn = 0; rch.pw = 0; }
          }
        }
        root.untried = untried;
        if (!root.children) root.children = [];
      } else {
        root = makeNode(turn, -1, null, 0, passes, -1);
        root.boardCopy = new Int8Array(n); root.boardCopy.set(srcBoard);
        root.pc = pc; root.outSig = outSig;
        root.untried = orderRootMoves(candMoves, turn, allowPass, passEnds, passGate);
        root.children = [];
      }
      var rootDepth = root.depth;

      var deadline = start + budgetMs;
      var it = 0;
      var bestSoFar = -1;
      if (USE_LGR) lgrTable.fill(-1);

      while (true) {
        if (timeLimited) {
          if (it !== 0 && (it & 7) === 0 && nowMs() >= deadline) break;
        } else if (it >= maxPlayouts) break;
        amafStamp++;

        // -------- selection / expansion --------
        treeBoard.set(srcBoard);
        capCount = 0;
        histLen = 0;
        var node = root, leaf = null;
        while (true) {
          if (node.terminal) { leaf = node; break; }
          var isAtRoot = (node === root);
          // Expansion threshold: do not allocate untried move lists until an
          // internal leaf has been visited EXPAND_THRESH times.
          if (!isAtRoot && node.untried === null && node.n < EXPAND_THRESH) {
            leaf = node;
            break;
          }
          if (node.untried === null) {
            node.untried = isAtRoot ? orderRootMoves(candMoves, turn, allowPass, passEnds, passGate) : buildUntried(node.mover, node.depth - rootDepth);
          }
          // Progressive widening at internal nodes: deepen promising variations
          // instead of exhausting all 60-120 untried moves before depth 2.
          var allowExpand = node.untried.length > 0;
          if (allowExpand && !isAtRoot && PW_K1 > 0 && node.children && node.children.length > 0) {
            var maxK = PW_K0 + PW_K1 * Math.sqrt(node.n);
            if (node.children.length >= maxK) allowExpand = false;
          }
          if (allowExpand) {
            var expanded = false;
            while (node.untried.length > 0) {
              var mv = node.untried.pop();
              var child;
              if (mv === -1) {
                child = makeNode(nextActivePlayer(node.mover), -1, node, node.depth + 1, node.passes + 1, -1);
                if (!node.children) node.children = [];
                node.children.push(child);
                histMove[histLen] = -1; histCapStart[histLen] = capCount; histCapEnd[histLen] = capCount; histLen++;
                node = child;
                if (child.passes >= activeCount) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
                else if (child.depth - rootDepth >= MAX_DEPTH) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
                leaf = child; expanded = true;
                break;
              }
              if (treeBoard[mv] !== 0 || mv === node.ko) continue;
              var hs = capCount;
              if (!applyMove(treeBoard, mv, node.mover)) { capCount = hs; continue; }
              if (amafMark[mv] !== amafStamp) { amafMark[mv] = amafStamp; amafWho[mv] = node.mover; }
              child = makeNode(nextActivePlayer(node.mover), mv, node, node.depth + 1, 0, lastKo);
              if (isAtRoot) { child.pn = rootPriorN[mv]; child.pw = rootPriorW[mv]; }
              if (!node.children) node.children = [];
              node.children.push(child);
              histMove[histLen] = mv; histCapStart[histLen] = hs; histCapEnd[histLen] = capCount; histLen++;
              node = child;
              if (child.depth - rootDepth >= MAX_DEPTH) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
              leaf = child; expanded = true;
              break;
            }
            if (expanded) break;
            if (node.children && node.children.length > 0) {
              // Remaining untried moves were illegal; fall through to UCT selection
            } else {
              node.terminal = true;
              node.termScores = terminalScores(treeBoard);
              leaf = node;
              break;
            }
          }
          // -------- all moves tried: UCT selection --------
          if (node.children && node.children.length > 0) {
            var sel = selectUCT(node, node === root);
            if (sel.move === -1) {
              histMove[histLen] = -1; histCapStart[histLen] = capCount; histCapEnd[histLen] = capCount; histLen++;
              node = sel;
            } else {
              var hs2 = capCount;
              var okS = applyMove(treeBoard, sel.move, node.mover);
              if (amafMark[sel.move] !== amafStamp) { amafMark[sel.move] = amafStamp; amafWho[sel.move] = node.mover; }
              histMove[histLen] = sel.move; histCapStart[histLen] = hs2; histCapEnd[histLen] = capCount; histLen++;
              node = sel;
              if (!okS) { /* should never happen: legality checked at creation */ }
            }
            if (node.terminal) { leaf = node; break; }
            continue;
          }
          // No children and no untried: cannot happen (pass is always available) — score.
          node.terminal = true;
          node.termScores = terminalScores(treeBoard);
          leaf = node;
          break;
        }

        // -------- rollout from leaf position --------
        if (leaf.terminal) {
          var ts = leaf.termScores;
          for (i = 0; i <= pc; i++) outSc[i] = ts[i];
        } else {
          runPlayout(leaf.mover, leaf.ko, leaf.passes);
        }

        // -------- backpropagation --------
        // Each node stores the outcome from the perspective of the mover of its
        // PARENT (the player who chose the move into it).  This makes UCT at any
        // node maximize its own mover's outcome, also in 3..6 player games.
        computeOutcome();
        // LGRF-1 update: record winner's replies, forget loser's replies.
        if (USE_LGR && plyHistLen > 0) {
          for (var li = 0; li < plyHistLen; li++) {
            var lp2 = plyHistP[li], lprev = plyHistPrev[li], lmv2 = plyHistMv[li];
            var lidx = lp2 * n + lprev;
            if (winArr[lp2] >= 0.5) lgrTable[lidx] = lmv2;
            else if (lgrTable[lidx] === lmv2) lgrTable[lidx] = -1;
          }
        }
        var nd = leaf, par;
        while (nd.parent !== null) {
          par = nd.parent;
          nd.n++;
          nd.w += winArr[par.mover];
          nd.v += valArr[par.mover];
          nd = par;
        }
        // Root has no parent: keep its own mover's perspective only.
        root.n++;
        root.w += winArr[rootMover];
        root.v += valArr[rootMover];
        // AMAF/RAVE: for every node on the path, credit child moves that were
        // played later in this simulation by that node's mover.
        var na = leaf;
        while (na !== null) {
          var ak = na.children;
          if (ak !== null && ak.length > 0) {
            var aw = winArr[na.mover];
            for (var ai = 0; ai < ak.length; ai++) {
              var acd = ak[ai], amv = acd.move;
              if (amv >= 0 && amafMark[amv] === amafStamp && amafWho[amv] === na.mover) { acd.rn++; acd.rw += aw; }
            }
          }
          na = na.parent;
        }

        // -------- undo traversal --------
        for (var hi = histLen - 1; hi >= 0; hi--) {
          var hm = histMove[hi];
          if (hm >= 0) undoMove(treeBoard, hm, histCapStart[hi], histCapEnd[hi]);
          else capCount = histCapStart[hi];
        }
        histLen = 0;

        it++;
        // Temperature: explore/fight more when behind, consolidate when ahead.
        if ((it & 63) === 0 && it >= 64) {
          var wrCur = root.n > 0 ? root.w / root.n : 0.5;
          curC = wrCur < 0.35 ? UCT_C * 1.25 : (wrCur > 0.62 ? UCT_C * 0.9 : UCT_C);
        }
        if (options.onProgress && (it & 255) === 0) {
          var bm = pickBestChild(root);
          if (bm >= 0) bestSoFar = bm.move;
          try { options.onProgress({ visits: root.n, playouts: it, elapsedMs: nowMs() - start, bestMove: bestSoFar }); } catch (err) { /* ignore */ }
        }
      }

      // -------- choose the move --------
      var best = pickBestChild(root);
      var move = -1;
      if (best) move = best.move;
      else {
        // Fallback: best-ordered candidate (center preference when board is empty).
        for (i = candMoves.length - 1; i >= 0; i--) { if (candMoves[i] === -1) continue; move = candMoves[i]; break; }
        if (move < 0 && emptyRoot > 0 && legalMark[geo.center]) move = geo.center;
      }
      // First-class pass decision: only pass when justified (otherwise use the
      // best placement even if the noisy search ranked pass highest).
      if (move === -1) {
        var passJustified = passEnds || passGate;
        if (!passJustified) {
          var bestNon = null;
          if (root.children) {
            for (i = 0; i < root.children.length; i++) {
              var cn0 = root.children[i];
              if (cn0.move >= 0 && cn0.n > 0 && (bestNon === null || cn0.n > bestNon.n)) bestNon = cn0;
            }
          }
          if (bestNon !== null) {
            var passWr = best.n > 0 ? best.w / best.n : 0;
            var nonWr = bestNon.w / bestNon.n;
            if (!(emptyRoot <= Math.floor(n * 0.5) && passWr >= nonWr + 0.02)) move = bestNon.move;
          }
        }
      }
      // Unconditional own-eye guard: NEVER fill a pure own eye (no capture) at
      // any search depth.  Filling an eye of a 2-eye group can kill our own
      // group and gains at most 0 points under area scoring.
      if (move >= 0 && rootCap[move] === 0 && ownEyeAt(srcBoard, move, turn) && root.children) {
        var bestNoEye = null;
        for (i = 0; i < root.children.length; i++) {
          var ce = root.children[i];
          if (ce.move < 0 || ce.n <= 0) continue;
          if (rootCap[ce.move] === 0 && ownEyeAt(srcBoard, ce.move, turn)) continue;
          if (bestNoEye === null || ce.n > bestNoEye.n) bestNoEye = ce;
        }
        move = bestNoEye !== null ? bestNoEye.move : -1;
      }
      // Never fill own settled territory (small/uninvadable unconditionally,
      // larger own regions below GUARD_MIN_VISITS) and never return a 100%-dead
      // invasion below GUARD_MIN_VISITS while a better search candidate exists.
      if (move >= 0 && rootCap[move] === 0 && !mvStab[move] && mvSave[move] === 0) {
        var isOwnReg = terrColorCount[move] === 1 && (terrColMask[move] & (1 << turn));
        var badSmallOwn = isOwnReg && terrSize[move] < V_MIN;
        var badSelf = badSmallOwn || (root.n < GUARD_MIN_VISITS && isOwnReg);
        var badInv = root.n < GUARD_MIN_VISITS && GAIN_POLICY && terrColorCount[move] === 1 &&
          !(terrColMask[move] & (1 << turn)) && !mvViable[move];
        if ((badSelf || badInv) && root.children) {
          var bestGood = null;
          for (i = 0; i < root.children.length; i++) {
            var cg = root.children[i];
            if (cg.move < 0 || cg.n <= 0) continue;
            if (rootCap[cg.move] === 0 && ownEyeAt(srcBoard, cg.move, turn)) continue;
            if (rootCap[cg.move] === 0 && !mvStab[cg.move] && mvSave[cg.move] === 0) {
              var cgOwn = terrColorCount[cg.move] === 1 && (terrColMask[cg.move] & (1 << turn));
              if (cgOwn && (cgOwn && terrSize[cg.move] < V_MIN || root.n < GUARD_MIN_VISITS)) continue;
              if (root.n < GUARD_MIN_VISITS && GAIN_POLICY && terrColorCount[cg.move] === 1 &&
                !(terrColMask[cg.move] & (1 << turn)) && !mvViable[cg.move]) continue;
            }
            if (bestGood === null || cg.n > bestGood.n) bestGood = cg;
          }
          if (bestGood !== null) move = bestGood.move;
          else if (badSmallOwn) move = -1;
        }
      }
      // Safety: never return an illegal placement.
      if (move >= 0 && !legalMark[move]) move = -1;

      // Resignation: 2 players only, genuinely hopeless, opt-in.  Applies to a
      // chosen pass as well (a frozen hopeless position: resign, do not drag it).
      var resignThreshold = options.resignThreshold;
      if (move >= -1 && resignThreshold != null && pc === 2 && root.n >= 128 && emptyRoot < n * 0.6) {
        var wr = root.n > 0 ? root.w / root.n : 1;
        var vl = root.n > 0 ? root.v / root.n : 0;
        if (wr < +resignThreshold && vl < -0.35) move = -2;
      }

      // -------- assemble result --------
      // Full root statistics (for root-parallel search: K workers can be merged
      // by summing visits / winrate*visits per move).  Filter out moves that
      // failed the own-territory / eye guards (when a non-guarded move exists)
      // so multi-worker pool.js merges never leak guarded fills.
      var rootMoves = [];
      if (root.children) {
        var hasUnguardedRM = false;
        for (i = 0; i < root.children.length; i++) {
          var rc0 = root.children[i];
          if (rc0.n <= 0 || rc0.move < 0) continue;
          if (rootCap[rc0.move] === 0 && ownEyeAt(srcBoard, rc0.move, turn)) continue;
          if (rootCap[rc0.move] === 0 && !mvStab[rc0.move] && mvSave[rc0.move] === 0) {
            var rcOwn = terrColorCount[rc0.move] === 1 && (terrColMask[rc0.move] & (1 << turn));
            if (rcOwn && (terrSize[rc0.move] < V_MIN || (root.n < GUARD_MIN_VISITS))) continue;
          }
          hasUnguardedRM = true;
          break;
        }
        var passOkRM = passEnds || passGate;
        for (i = 0; i < root.children.length; i++) {
          var rmc = root.children[i];
          if (rmc.n <= 0) continue;
          if (rmc.move === -1 && !passOkRM && hasUnguardedRM) continue;
          if (rmc.move >= 0 && hasUnguardedRM) {
            if (rootCap[rmc.move] === 0 && ownEyeAt(srcBoard, rmc.move, turn)) continue;
            if (rootCap[rmc.move] === 0 && !mvStab[rmc.move] && mvSave[rmc.move] === 0) {
              var rmOwn = terrColorCount[rmc.move] === 1 && (terrColMask[rmc.move] & (1 << turn));
              if (rmOwn && (terrSize[rmc.move] < V_MIN || (root.n < GUARD_MIN_VISITS))) continue;
            }
          }
          rootMoves.push({
            move: rmc.move,
            visits: rmc.n,
            winrate: rmc.w / rmc.n,
            value: rmc.v / rmc.n
          });
        }
      }
      var bestMoves = [];
      if (root.children) {
        var sorted = root.children.slice().sort(function (a, b) { return b.n - a.n || (b.n ? b.w / b.n : 0) - (a.n ? a.w / a.n : 0) || a.move - b.move; });
        for (i = 0; i < sorted.length && i < 8; i++) {
          var cm = sorted[i];
          bestMoves.push({ move: cm.move, visits: cm.n, value: cm.n > 0 ? cm.w / cm.n : 0 });
        }
      }

      engine._root = root;

      return {
        move: move,
        visits: root.n,
        playouts: it,
        winrate: root.n > 0 ? root.w / root.n : 0,
        value: root.n > 0 ? root.v / root.n : 0,
        bestMoves: bestMoves,
        rootMoves: rootMoves,
        elapsedMs: nowMs() - start,
        engine: VERSION
      };
    }

    function nextActivePlayer(p) {
      var t = p;
      do { t = (t % pcCur) + 1; } while (outFlags[t]);
      return t;
    }

    function pickBestChild(root) {
      var kids = root.children;
      if (!kids || kids.length === 0) return null;
      var best = null, bestN = -1, bestRw = -2;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        var rw = ch.n > 0 ? ch.w / ch.n : -1;
        if (ch.n > bestN || (ch.n === bestN && rw > bestRw)) { bestN = ch.n; bestRw = rw; best = ch; }
      }
      return best;
    }

    /* ------------------------------------------------------------------ *
     *  Engine object
     * ------------------------------------------------------------------ */

    var engine = {
      size: geo.size,
      n: n,
      think: think,
      _rootLegalMoves: rootLegalMovesImpl,
      _scoreBoard: scoreBoardImpl,
      _deadStones: deadStonesImpl,
      // v2.2: smart dead-stone port (page detectDeadStonesSmart parity;
      // verified 1:1 by dev/smart-parity.js).  Always runs the smart logic so
      // the parity tool measures the port itself, not the SMART_DEAD default.
      _deadStonesSmart: function (board, pc) {
        var out = [];
        dsBoard.set(board);
        removeDeadStonesSmartImpl(dsBoard, pc | 0 || 2);
        for (var q = 0; q < n; q++) if (board[q] !== 0 && dsBoard[q] === 0) out.push(q);
        return out;
      },
      _patternScore: function (board, i, p) { return patternScore(board, i, p | 0); },
      _territoryOwner: function (board) {
        computeTerritory(board, pcCur);
        var out = new Array(n);
        for (var q = 0; q < n; q++) out[q] = terrOwner[q];
        return out;
      },
      _root: null
    };
    return engine;
  }

  /* ------------------------------------------------------------------ *
   *  Module / worker export
   * ------------------------------------------------------------------ */

  var API = {
    version: VERSION,
    geometry: geometry,
    createEngine: createEngine,
    hashBoard: hashBoard,
    _internals: {
      sizeFromN: sizeFromN,
      rootLegalMoves: function (state) {
        var board = state && state.board;
        if (!board) throw new Error('rootLegalMoves: state.board required');
        var size = state.size | 0;
        if (!size) size = sizeFromN(board.length);
        if (size < 3) throw new Error('rootLegalMoves: unknown board length ' + board.length);
        return createEngine({ size: size, playerCount: (state.playerCount | 0) || 2 })._rootLegalMoves(state);
      },
      scoreBoard: function (board, pc) {
        var size = sizeFromN(board.length);
        if (size < 3) throw new Error('scoreBoard: unknown board length ' + board.length);
        return createEngine({ size: size, playerCount: (pc | 0) || 2 })._scoreBoard(board, pc | 0 || 2);
      }
    }
  };

  if (typeof module !== 'undefined' && module && module.exports) module.exports = API;
  if (globalScope) {
    try { globalScope.HexagoAI = API; } catch (err) { /* ignore */ }
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
