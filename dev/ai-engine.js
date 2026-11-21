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

  var VERSION = 'hexago-mcts/2.1.0';

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

    var UCT_C = opts.uctC != null ? +opts.uctC : 1.1;
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

    // S0 baseline: the area score each player gets if everyone passes right now
    // (conservative dead-stone removal, exactly like the page's scoring).
    function computeBaseline(pc) {
      gainBoard.set(srcBoard);
      removeDeadStones(gainBoard);
      scoreBoardInto(gainBoard, baseSc, pc);
    }

    // Static score gain of playing `mv`: place, clean dead stones, score,
    // and subtract the pass-now baseline. Own-territory fills are 0, dame +1,
    // captures count exactly, dead invasions die in the cleanup.
    function staticGainFor(mv, p, pc) {
      gainBoard.set(srcBoard);
      capCount = 0;
      if (!applyMove(gainBoard, mv, p)) { capCount = 0; return -32768; }
      capCount = 0;
      removeDeadStones(gainBoard);
      scoreBoardInto(gainBoard, gainSc, pc);
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
        mvStab[mv] = countStabAt(srcBoard, mv, turn) > 0 ? 1 : 0;
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
        // ---- v2.1 gain policy ----
        // is the move inside a region bordered by exactly one enemy colour
        // (their solid territory)?  Only those are "dead invasion" risks;
        // a contested (2+-colour) region is normal play/dame for anyone.
        inv = terrColorCount[mv] === 1 && !(terrColMask[mv] & (1 << turn));
        // does it touch an enemy group with <= 3 liberties? (kill / capture race / ko threat material)
        nearWeakEn = 0;
        for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
          var s = nbFlat[j];
          if (srcBoard[s] !== 0 && srcBoard[s] !== turn && atkLibs[s] <= 3) { nearWeakEn = 1; break; }
        }
        viable = 0;
        if (!inv || rootCap[mv] > 0 || nearWeakEn) viable = 1;
        else if (terrSize[mv] >= V_DEEP && libs >= 3) viable = 1;              // huge region: real deep invasion
        else if (terrSize[mv] >= V_MIN && libs >= 3) {
          nd = nearestOwnWithin(srcBoard, mv, turn, 3);
          if (nd <= 3) viable = 1;                                             // supported reduction/invasion
          else if (libs >= 4 && nearestOwnWithin(srcBoard, mv, turn, 4) <= 4) viable = 1;
        }
        if (terrSize[mv] < V_MIN && !nearWeakEn) viable = 0;                   // no two eyes possible: dead stone
        mvViable[mv] = viable;
        g = staticGainFor(mv, turn, pcCur);
        if (inv && !viable) g = 0;                                             // 100%-dead invasion: exactly worthless
        ownGain[mv] = g;
        useful = g > 0 || (rootCap[mv] > 0 && viable) || (mvSave[mv] > 0 && libs >= 2) || (mvStab[mv] && libs >= 2 && nearWeakEn);
        if (eye && rootCap[mv] === 0) useful = false;                          // never fill our own eye
        if (libs === 1 && rootCap[mv] === 0) useful = false;                   // self-atari
        if (terrColorCount[mv] === 1 && (terrColMask[mv] & (1 << turn)) && g <= 0 && rootCap[mv] === 0 && mvSave[mv] === 0 && !mvStab[mv]) useful = false; // own settled territory, any size
        mvUseful[mv] = useful ? 1 : 0;
        atkB[mv] = ATK_ORDER ? atkBonusAt(mv, turn) : 0;
        if (useful) noUsefulRoot = false;
      }
      if (GAIN_POLICY) computeEnemyThreat(turn, pcCur, ownWeak);
      return noUsefulRoot;
    }

    // Can any active opponent still change the score? (blocks the pass gate)
    // (a) dame / mixed regions exist, (b) one of our single-colour regions is
    // invadable at a supported (or deep-huge) point, (c) we have a capturable
    // weak group. When none of these hold, the position is frozen for everyone.
    function computeEnemyThreat(turn, pc, ownWeak) {
      enemyThreat = ownWeak || dameExists;
      if (enemyThreat) return;
      var e, i, j, je, libs;
      for (e = 1; e <= pc && !enemyThreat; e++) {
        if (e === turn || outFlags[e]) continue;
        fillColorNear(srcBoard, e, 4);
        for (i = 0; i < n; i++) {
          if (srcBoard[i] !== 0) continue;
          if (terrColorCount[i] !== 1 || !(terrColMask[i] & (1 << turn))) continue; // only our regions
          if (terrSize[i] < V_MIN) continue;                                        // too small to live in
          libs = 0;
          for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (srcBoard[nbFlat[j]] === 0) libs++;
          if (libs < 3) continue;
          if (enemyNear[i] <= 3 || (terrSize[i] >= V_DEEP && libs >= 4)) { enemyThreat = true; break; }
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

    // own groups adjacent to `move` that are down to <= 2 liberties: the move
    // connects to / defends them.  Keeps needed defensive moves search-eligible
    // even when their static score gain is 0.
    function countStabAt(board, move, p) {
      var sid = ++saveId, cnt = 0;
      for (var j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        var s = nbFlat[j];
        if (board[s] !== p || saveStamp[s] === sid) continue;
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
      var scored = [], mi, mv, sc, j, je, v, own, opp, save, eye, owner, dd;
      var opening = stoneCountRoot <= Math.max(6, (n * 0.22) | 0);
      var endgame = emptyRoot <= n * 0.55;
      var inv;
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
            if (inv && mvViable[mv]) sc += Math.min(terrSize[mv], 40) * 3;      // a living invasion dissolves their region
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
          if (eye && rootCap[mv] === 0) sc -= 900;                               // never fill our own eye
          if (terrColorCount[mv] === 1 && (terrColMask[mv] & (1 << turn)) && rootCap[mv] === 0 && save === 0 && !mvStab[mv]) sc -= 700; // never fill own territory (any size)
          else if (owner === 0 && rootLibs[mv] >= 2) sc += 10;                   // safe neutral point (dame, +1)
          if (opening) {
            dd = nearestStoneDist(srcBoard, mv);
            sc += dd >= 3 ? 40 : dd === 2 ? 22 : dd === 1 ? 4 : 0;               // build a framework, not only adjacent
            sc += (n - geomDistCenter[mv]) * (pcCur >= 3 ? 0.12 : 0.20);         // many players: the centre is contested, edges pay
            if (pcCur >= 3 && geomDistCenter[mv] >= (geo.size - 1) * 0.35) sc += 14; // space race: corner/edge frameworks
            if (nbMask[mv] !== FULL_MASK) sc -= 28;                              // edge penalty while opening
            sc += rng() * 60;                                                    // opening variety (seeded)
          } else if (endgame) {
            sc += rng() * 4;
          } else {
            sc += rng() * 10;
          }
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
     *  Rollout ("playout") policy
     * ================================================================== */

    var pboard = new Int8Array(n);
    var empList = new Int16Array(n), empPos = new Int16Array(n), empCount = 0;
    var candList = new Int16Array(n), candCount = 0;
    var candOwn = new Int8Array(n), candEn = new Int8Array(n);
    var gStamp = new Int32Array(n);
    var gLibs = new Int16Array(n), gLibPt = new Int16Array(n), gSize = new Int16Array(n);
    var turnId = 0;
    var pcapCap = 4 * n + 64;
    var pcapPos = new Int16Array(pcapCap), pcapColor = new Int8Array(pcapCap), pcapCount = 0;
    var stoneCnt = new Int16Array(8);
    var plyKo = -1, plyPasses = 0, plyMover = 0;
    var plyLastMove = -1, plyPrevMove = -1;
    var anaList = new Int16Array(24), anaCount = 0;
    var anaMark = new Int32Array(n), anaId = 0;
    var pLastCap = 0, pLastKo = -1, pLastOwnLibs = 0;
    var tBestCap = -1, tBestCapSize = 0, tBestSave = -1, tBestSaveSize = 0;
    var tBestAtk2 = -1, tBestAtk2Size = 0;
    var rng = mulberry32(1);
    var amafMark = new Int32Array(n), amafWho = new Int8Array(n), amafStamp = 0;

    function playApply(move, p) {
      pboard[move] = p;
      var cs = pcapCount;
      var aid = ++applyId;
      var j, je, t, c, gi, k, captured = 0;
      for (j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        t = nbFlat[j]; c = pboard[t];
        if (c === 0 || c === p || applyStamp[t] === aid) continue;
        if (scanGroup(pboard, t, c, 1) !== 0) continue; // has a liberty -> no capture
        gi = grpN;
        for (k = 0; k < gi; k++) applyStamp[grpBuf[k]] = aid;
        for (k = 0; k < gi; k++) { pcapPos[pcapCount] = grpBuf[k]; pcapColor[pcapCount] = c; pcapCount++; captured++; }
      }
      if (captured > 0) {
        for (k = cs; k < pcapCount; k++) pboard[pcapPos[k]] = 0;
        pLastCap = captured;
        pLastKo = captured === 1 ? pcapPos[cs] : -1;
        pLastOwnLibs = 2;
        return 1;
      }
      scanGroup(pboard, move, p, 2);
      if (lastLibs === 0) {
        pboard[move] = 0; pcapCount = cs;
        pLastCap = 0; pLastKo = -1; pLastOwnLibs = 0;
        return 0;
      }
      pLastCap = 0; pLastKo = -1; pLastOwnLibs = lastLibs;
      return 1;
    }

    function playUndo(move, cs) {
      pboard[move] = 0;
      for (var k = cs; k < pcapCount; k++) pboard[pcapPos[k]] = pcapColor[k];
      pcapCount = cs;
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

    // Tactical scan of ONE candidate point: does playing it capture an enemy
    // group in atari, or save an own group in atari?  Group liberty info is
    // cached per turn, keyed by stone index.
    function tacticScan(p, e, tid) {
      var j, je, k, s, c, x, gi, libs, lp;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        s = nbFlat[j]; c = pboard[s];
        if (c === 0) continue;
        if (gStamp[s] !== tid) {
          scanGroup(pboard, s, c, 2);
          gi = grpN; libs = lastLibs; lp = lastLibPt;
          for (k = 0; k < gi; k++) { x = grpBuf[k]; gStamp[x] = tid; gLibs[x] = libs; gLibPt[x] = lp; gSize[x] = gi; }
        } else { gi = gSize[s]; libs = gLibs[s]; lp = gLibPt[s]; }
        if (libs === 1 && lp === e) {
          if (c === p) { if (gi > tBestSaveSize) { tBestSave = e; tBestSaveSize = gi; } }
          else { if (gi > tBestCapSize) { tBestCap = e; tBestCapSize = gi; } }
        } else if (PLAYOUT_ATK && c !== p && libs === 2 && gi > tBestAtk2Size) {
          // e is one of this enemy group's two liberties: playing it puts the
          // group in atari.  Playouts that never pressure 2-lib groups
          // systematically undervalue attacks (defensive bias).
          tBestAtk2 = e; tBestAtk2Size = gi;
        }
      }
    }

    // Build the local candidate list for this turn and pick a small set of
    // candidates for tactical analysis.
    //   n <= 127 (9x9/13x13): analyse every local candidate (strongest, still fast)
    //   larger boards: analyse only moves around the last two moves plus a few
    //   random candidates (keeps light playouts cheap on 19x19/25x25)
    var FULL_ANALYSIS_LIMIT = 127;
    function analyzeTurn(p) {
      var tid = ++turnId;
      candCount = 0; tBestCap = -1; tBestCapSize = 0; tBestSave = -1; tBestSaveSize = 0;
      tBestAtk2 = -1; tBestAtk2Size = 0;
      var ei, e, j, je, local;
      for (ei = 0; ei < empCount; ei++) {
        e = empList[ei];
        local = 0;
        for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (pboard[nbFlat[j]] !== 0) { local = 1; break; }
        if (local) candList[candCount++] = e;
      }
      if (candCount === 0 && empCount > 0) {
        for (ei = 0; ei < empCount; ei++) candList[candCount++] = empList[ei];
      }
      // --- choose tactical candidates ---
      if (n <= FULL_ANALYSIS_LIMIT) {
        for (ei = 0; ei < candCount; ei++) tacticScan(p, candList[ei], tid);
        return;
      }
      anaId++;
      anaCount = 0;
      var lm = plyLastMove, pm = plyPrevMove, k2;
      if (lm >= 0) {
        for (j = nbOff[lm], je = nbOff[lm + 1]; j < je; j++) {
          var t = nbFlat[j];
          if (pboard[t] === 0 && anaMark[t] !== anaId) { anaMark[t] = anaId; if (anaCount < 24) anaList[anaCount++] = t; }
        }
      }
      if (pm >= 0) {
        for (j = nbOff[pm], je = nbOff[pm + 1]; j < je; j++) {
          var t2 = nbFlat[j];
          if (pboard[t2] === 0 && anaMark[t2] !== anaId) { anaMark[t2] = anaId; if (anaCount < 24) anaList[anaCount++] = t2; }
        }
      }
      // top up with a random sample of candidates
      var want = 12, tries = 0;
      while (anaCount < want && candCount > 0 && tries < 24) {
        var e2 = candList[(rng() * candCount) | 0];
        tries++;
        if (anaMark[e2] === anaId) continue;
        anaMark[e2] = anaId;
        anaList[anaCount++] = e2;
      }
      for (k2 = 0; k2 < anaCount; k2++) tacticScan(p, anaList[k2], tid);
    }

    function tryAccept(p, e) {
      if (pboard[e] !== 0) return 0;
      if (e === plyKo) return 0;
      var cs = pcapCount;
      if (!playApply(e, p)) { pcapCount = cs; return 0; }
      // Reject self-atari (own group left with a single liberty) unless it captured.
      if (pLastCap === 0 && pLastOwnLibs === 1 && rng() < SELF_ATARI_REJECT) { playUndo(e, cs); return 0; }
      stoneCnt[p]++;
      for (var k = cs; k < pcapCount; k++) stoneCnt[pcapColor[k]]--;
      removeEmpty(e);
      amafMark[e] = amafStamp; amafWho[e] = p;
      plyKo = pLastKo;
      plyPrevMove = plyLastMove;
      plyLastMove = e;
      return 1;
    }

    // One rollout turn. Returns 1 if a stone was placed, 0 if passing.
    // v1.2.0 light local policy (kept for playing strength): captures/saves,
    // then random local moves; never fill our own eyes (passes instead).
    function playoutTurn(p) {
      analyzeTurn(p);
      if (tBestCap >= 0 && rng() < 0.9) { if (tryAccept(p, tBestCap)) return 1; }
      if (tBestSave >= 0 && rng() < 0.85) { if (tryAccept(p, tBestSave)) return 1; }
      if (tBestAtk2 >= 0 && rng() < 0.35) { if (tryAccept(p, tBestAtk2)) return 1; }
      if (candCount > 0) {
        var a, e;
        for (a = 0; a < 8; a++) {
          e = candList[(rng() * candCount) | 0];
          if (isOwnEye(e, p)) continue;
          if (tryAccept(p, e)) return 1;
        }
        for (a = 0; a < candCount; a++) {
          e = candList[a];
          if (isOwnEye(e, p)) continue;
          if (tryAccept(p, e)) return 1;
        }
      }
      return 0;
    }

    function runPlayout(startMover, startKo, startPasses) {
      var i, j, je, t, v;
      pboard.set(treeBoard);
      empCount = 0;
      for (i = 0; i < n; i++) if (pboard[i] === 0) { empPos[i] = empCount; empList[empCount++] = i; }
      pcapCount = 0;
      for (i = 1; i <= pcCur; i++) stoneCnt[i] = 0;
      for (i = 0; i < n; i++) { v = pboard[i]; if (v !== 0) stoneCnt[v]++; }
      plyKo = startKo; plyPasses = startPasses; plyMover = startMover;
      plyLastMove = -1; plyPrevMove = -1;
      var maxSteps = MAX_PLAYOUT_STEPS;
      for (var step = 0; step < maxSteps; step++) {
        var played = playoutTurn(plyMover);
        if (played === 0) { plyPasses++; plyKo = -1; plyLastMove = -1; plyPrevMove = -1; }
        if (plyPasses >= activeCount) break;
        var t2 = plyMover;
        do { t2 = (t2 % pcCur) + 1; } while (outFlags[t2]);
        plyMover = t2;
      }
      removeDeadStones(pboard);
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
      if (pcCur >= 3) {
        for (p = 1; p <= pcCur; p++) {
          if (outFlags[p]) continue;
          winArr[p] = winArr[p] * RANK_BLEND + (valArr[p] * 0.5 + 0.5) * (1 - RANK_BLEND);
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
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.n <= 0) { return ch; }
        // ch.w / ch.rw are accumulated for the mover of `node` (the parent).
        var q = ch.w / ch.n;
        if (ch.rn > 0) {
          // MoGo-style RAVE weight: conservative early, decaying with visits.
          var b = 0.05, rn = ch.rn, nv = ch.n;
          var beta = rn / (rn + nv + 4 * nv * rn * b * b);
          q = (1 - beta) * q + beta * (ch.rw / rn);
        }
        var v = q + curC * Math.sqrt(ln / ch.n);
        // Progressive bias: a certain-kill root move (enclosed enemy group)
        // gets early exploration priority so an N-stone capture is never
        // drowned in playout noise on big open boards.  Decays to a floor - a
        // verified capture is always worth taking unless the playout value
        // refutes it clearly.
        if (isRoot && ch.move >= 0 && atkB[ch.move] > 2000) {
          v += Math.max(0.35, 1.2 - 0.025 * ch.n);
        }
        if (v > bestV) { bestV = v; best = ch; }
      }
      return best;
    }

    function terminalScores(board) {
      dsBoard.set(board);
      removeDeadStones(dsBoard);
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
      if (turnId > 1000000000) { gStamp.fill(0); turnId = 0; }
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

      // Root search candidates: only moves that change the score or stabilize.
      // (Legacy policy searches every legal move; A/B reference.)
      var candMoves = legal;
      if (GAIN_POLICY && RESTRICT_CAND) {
        candMoves = [];
        for (i = 0; i < legal.length; i++) {
          if (legal[i] >= 0 && mvUseful[legal[i]]) candMoves.push(legal[i]);
        }
        if (candMoves.length === 0) {
          // No useful move but opponents can still gain: defend.  Anything that
          // is not an eye fill / self-atari / doomed invasion is considered.
          for (i = 0; i < legal.length; i++) {
            var fm = legal[i];
            if (fm < 0) continue;
            if (ownEyeAt(srcBoard, fm, turn) && rootCap[fm] === 0) continue;
            if (rootLibs[fm] === 1 && rootCap[fm] === 0) continue;
            if (terrColorCount[fm] > 0 && !(terrColMask[fm] & (1 << turn)) && !mvViable[fm]) continue;
            candMoves.push(fm);
          }
        }
      }
      var candMark = legalMark;   // reuse: 1 = searchable root placement
      if (GAIN_POLICY) {
        if (RESTRICT_CAND) candMark = new Uint8Array(n);
        for (i = 0; i < candMoves.length; i++) if (candMoves[i] >= 0) candMark[candMoves[i]] = 1;
        if (allowPass && candMoves[candMoves.length - 1] !== -1) candMoves.push(-1);
      }

      // The position is frozen for everyone: passing is the correct decision
      // (instant, zero playouts - this is where the endgame time budget goes).
      if (passGate) {
        simBoard.set(srcBoard);
        capCount = 0;
        removeDeadStones(simBoard);
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

      // ---- Tree reuse: adopt a stored child whose position == current position.
      if (oldRoot && oldRoot.children && oldRoot.children.length && oldRoot.pc === pc && oldRoot.outSig === outSig && oldRoot.boardCopy) {
        var chs = oldRoot.children, ci, ch, okR, eq;
        for (ci = 0; ci < chs.length; ci++) {
          ch = chs[ci];
          if (ch.mover !== turn || ch.passes !== passes) continue;
          if (ch.move !== -1 && !legalMark[ch.move]) continue;
          if (ch.move === -1) {
            if (ch.passes !== passes) continue;
            for (eq = 1, i = 0; i < n; i++) { if (oldRoot.boardCopy[i] !== srcBoard[i]) { eq = 0; break; } }
          } else {
            cmpBoard.set(oldRoot.boardCopy);
            capCount = 0;
            okR = applyMove(cmpBoard, ch.move, oldRoot.mover);
            capCount = 0;
            if (!okR) continue;
            eq = 1;
            for (i = 0; i < n; i++) if (cmpBoard[i] !== srcBoard[i]) { eq = 0; break; }
          }
          if (!eq) continue;
          // Validate that the adopted subtree's root children are still root-legal moves.
          var kids = ch.children;
          if (kids) {
            for (var ki = 0; ki < kids.length; ki++) {
              var km = kids[ki].move;
              if (km !== -1 && !legalMark[km]) { eq = 0; break; }
            }
          }
          if (eq) { root = ch; break; }
        }
      }

      if (root) {
        root.parent = null;
        root.depth = 0;
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
          if (node.untried === null) {
            node.untried = node.depth === rootDepth ? orderRootMoves(candMoves, turn, allowPass, passEnds, passGate) : buildUntried(node.mover, node.depth - rootDepth);
          }
          if (node.untried.length > 0) {
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
              amafMark[mv] = amafStamp; amafWho[mv] = node.mover;
              child = makeNode(nextActivePlayer(node.mover), mv, node, node.depth + 1, 0, lastKo);
              if (!node.children) node.children = [];
              node.children.push(child);
              histMove[histLen] = mv; histCapStart[histLen] = hs; histCapEnd[histLen] = capCount; histLen++;
              node = child;
              if (child.depth - rootDepth >= MAX_DEPTH) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
              leaf = child; expanded = true;
              break;
            }
            if (expanded) break;
            // All untried moves were illegal at this node; score it as terminal.
            node.terminal = true;
            node.termScores = terminalScores(treeBoard);
            leaf = node;
            break;
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
              amafMark[sel.move] = amafStamp; amafWho[sel.move] = node.mover;
              histMove[histLen] = sel.move; histCapStart[histLen] = hs2; histCapEnd[capCount]; histLen++;
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
      // Never fill our own eye / own settled territory (any size) and never
      // return a 100%-dead invasion while a better search candidate exists.
      // Under the gain policy these are already excluded from the candidates;
      // with full search freedom (default) this guard is the guarantee.
      if (move >= 0 && rootCap[move] === 0 && !mvStab[move] && mvSave[move] === 0) {
        var badSelf = ownEyeAt(srcBoard, move, turn) ||
          (terrColorCount[move] === 1 && (terrColMask[move] & (1 << turn)));
        var badInv = GAIN_POLICY && terrColorCount[move] === 1 &&
          !(terrColMask[move] & (1 << turn)) && !mvViable[move];
        if ((badSelf || badInv) && root.children) {
          var bestGood = null;
          for (i = 0; i < root.children.length; i++) {
            var cg = root.children[i];
            if (cg.move < 0 || cg.n <= 0) continue;
            if (rootCap[cg.move] === 0 && !mvStab[cg.move] && mvSave[cg.move] === 0) {
              if (ownEyeAt(srcBoard, cg.move, turn) ||
                  (terrColorCount[cg.move] === 1 && (terrColMask[cg.move] & (1 << turn)))) continue;
              if (GAIN_POLICY && terrColorCount[cg.move] === 1 &&
                !(terrColMask[cg.move] & (1 << turn)) && !mvViable[cg.move]) continue;
            }
            if (bestGood === null || cg.n > bestGood.n) bestGood = cg;
          }
          if (bestGood !== null) move = bestGood.move;
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
      // by summing visits / winrate*visits per move).
      var rootMoves = [];
      if (root.children) {
        for (i = 0; i < root.children.length; i++) {
          var rmc = root.children[i];
          if (rmc.n <= 0) continue;
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
