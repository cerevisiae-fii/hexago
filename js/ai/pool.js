// ===== AI 制御（MCTS エンジン / Web Worker プール） =====
// エンジン本体は js/ai/engine.js（dev/ai-engine.js のコピー）。ページでは classic script として
// 読み込んで window.HexagoAI を提供し、Worker では js/ai/worker.js が importScripts で同じファイルを
// 読み込む。強さに応じて複数 Worker で同じ局面を並列探索し（root parallel MCTS）、
// ルート直下の訪問数を合算して着手を選ぶ。Worker が使えない環境ではメインスレッドで短い予算、
// それも失敗した場合だけ従来の1手読み AI (aiChoose) にフォールバックする。
// AI モード: 'fast'（標準・高速 2.5〜6s・最大4並列）と 'beta'（最強β 12〜15s・最大8並列）を切替可能。
let aiTestBudgetMs = null, lastAIStats = null;
let aiGeneration = 0, aiWorkerError = '', aiMsgSeq = 0, aiWaiters = new Map();
let aiPool = [];   // [{ index, worker, url, failed }]
let aiMainAPI = null, aiMainEngines = Object.create(null);
// pool.js 自身のURLから worker.js を解決する（サブディレクトリ配信でも動く）。
const AI_WORKER_URL = (function () {
  try {
    const here = document.currentScript && document.currentScript.src;
    return here ? new URL('worker.js', here).href : './js/ai/worker.js';
  } catch (e) { return './js/ai/worker.js'; }
})();

function currentAIMode() {
  return (typeof aiMode === 'string' && aiMode === 'beta') ? 'beta' : 'fast';
}
function setAIMode(nextMode) {
  const m = nextMode === 'beta' ? 'beta' : 'fast';
  if (typeof aiMode !== 'undefined' && aiMode === m) return m;
  aiMode = m;
  // 並列数が変わるので待機中プールを作り直す（思考中なら完了後に自然調整）
  if (!aiBusy && aiPool.length) {
    aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
    aiPool = [];
  }
  return m;
}
function aiBudgetMs() {
  if (aiTestBudgetMs != null) return aiTestBudgetMs;
  const pts = P.length;
  if (currentAIMode() === 'beta') {
    // 最強（β）: 最大予算で深く読む。終盤の即パス判定は同様に効く。
    return pts >= 250 ? 15000 : 12000;
  }
  // 高速（標準）: 1個前の高速予算（9路2.5s / 13路3s / 19路4s / 25路6s）。
  if (pts >= 450) return 6000;
  if (pts >= 250) return 4000;
  if (pts >= 120) return 3000;
  return 2500;
}
function aiPoolWant() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  let want = currentAIMode() === 'beta'
    ? Math.min(8, Math.max(1, cores))
    : Math.min(4, Math.max(1, cores - 1));
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (mem <= 4) want = Math.min(want, 2);
  return Math.max(1, want);
}
function aiEngineLoaded() {
  return typeof self !== 'undefined' && self.HexagoAI && typeof self.HexagoAI.createEngine === 'function';
}
function makeAIWorkerSlot(index) {
  const slot = { index: index, worker: null, url: AI_WORKER_URL, failed: false };
  const w = new Worker(AI_WORKER_URL);
  slot.worker = w;
  w.onmessage = ev => {
    const d = ev.data || {};
    const waiter = aiWaiters.get(d.id);
    if (!waiter) return;
    if (d.progress) {
      waiter.progress = d.progress;
      let total = 0;
      aiWaiters.forEach(w2 => { if (w2.progress) total += w2.progress.visits || 0; });
      const el = document.getElementById('aiOvText');
      if (el) el.textContent = 'AI 思考中… ' + Math.max(total, d.progress.visits || 0).toLocaleString() + ' 局面を読んでいます';
      return;
    }
    aiWaiters.delete(d.id);
    if (d.ok) waiter.resolve(d.result);
    else waiter.reject(new Error(d.error || 'AI engine error'));
  };
  w.onerror = ev => {
    const msg = (ev && ev.message) || 'AI worker error';
    slot.failed = true;
    aiWorkerError = msg;
    aiWaiters.forEach((waiter, id) => {
      if (waiter.slot === slot) { aiWaiters.delete(id); waiter.reject(new Error(msg)); }
    });
  };
  return slot;
}
function ensureAIPool() {
  aiPool = aiPool.filter(slot => !slot.failed);
  const want = aiPoolWant();
  if (!aiEngineLoaded()) { aiWorkerError = 'AI engine is not loaded'; return []; }
  try {
    while (aiPool.length < want) aiPool.push(makeAIWorkerSlot(aiPool.length));
  } catch (err) {
    aiWorkerError = String((err && err.message) || err);
    aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
    aiPool = [];
  }
  return aiPool;
}
function ensureMainAI() {
  if (aiMainAPI) return aiMainAPI;
  if (!aiEngineLoaded()) throw new Error('AI engine is not loaded');
  aiMainAPI = self.HexagoAI;
  return aiMainAPI;
}
function mainAIEngine(state) {
  const key = state.size + ':' + state.playerCount;
  if (!aiMainEngines[key]) aiMainEngines[key] = ensureMainAI().createEngine({ size: state.size, playerCount: state.playerCount });
  return aiMainEngines[key];
}
function aiStateSnapshot() {
  return {
    size: G.size,
    playerCount: G.playerCount || playerCount,
    turn: G.turn,
    board: G.board.slice(),
    out: G.out.slice(),
    passes: G.passes,
    seen: G.seen.slice(),
  };
}
function aiThinkOnSlot(slot, state, budgetMs) {
  return new Promise((resolve, reject) => {
    const id = ++aiMsgSeq;
    const timer = setTimeout(() => { aiWaiters.delete(id); reject(new Error('AI timeout')); }, budgetMs + 15000);
    aiWaiters.set(id, {
      slot: slot,
      resolve: r => { clearTimeout(timer); resolve(r); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    slot.worker.postMessage({ id: id, state: state, options: { budgetMs: budgetMs, returnAllMoves: true, resignThreshold: 0.02 } });
  });
}
// root parallel MCTS: 各 Worker のルート直下の訪問数を合算して着手を選ぶ。
function mergeAIResults(results) {
  // 全 Worker が即パス／投了を返した場合はそのまま尊重する
  if (results.every(r => r && r.move === -2)) return Object.assign({}, results[0], { workers: results.length });
  if (results.every(r => r && r.move === -1)) return Object.assign({}, results[0], { workers: results.length });
  const acc = new Map();
  for (const r of results) {
    const list = (Array.isArray(r.rootMoves) && r.rootMoves.length) ? r.rootMoves : (r.bestMoves || []);
    for (const e of list) {
      if (!e || !Number.isInteger(e.move)) continue;
      const v = Number.isFinite(e.winrate) ? e.winrate : (Number.isFinite(e.value) ? e.value : 0.5);
      const n = Math.max(1, e.visits | 0);
      const cur = acc.get(e.move) || { move: e.move, visits: 0, wsum: 0, wn: 0 };
      cur.visits += n;
      cur.wsum += v * n;
      cur.wn += n;
      acc.set(e.move, cur);
    }
  }
  let best = null, bestVal = -Infinity;
  for (const c of acc.values()) {
    const v = c.wn ? c.wsum / c.wn : 0;
    if (!best || c.visits > best.visits || (c.visits === best.visits && v > bestVal)) { best = c; bestVal = v; }
  }
  const totalVisits = results.reduce((n, r) => n + (r.visits || 0), 0);
  const totalPlayouts = results.reduce((n, r) => n + (r.playouts || 0), 0);
  const totalW = results.reduce((n, r) => n + (r.winrate || 0) * (r.visits || 0), 0);
  const mergedMoves = [...acc.values()]
    .map(c => ({ move: c.move, visits: c.visits, value: c.wn ? c.wsum / c.wn : 0 }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8);
  return {
    move: best ? best.move : -1,
    visits: totalVisits,
    playouts: totalPlayouts,
    winrate: totalVisits ? totalW / totalVisits : 0,
    value: 0,
    bestMoves: mergedMoves,
    rootMoves: mergedMoves,
    elapsedMs: results.reduce((m, r) => Math.max(m, r.elapsedMs || 0), 0),
    workers: results.length,
    engine: results[0] && results[0].engine,
  };
}
function aiThink(state, budgetMs) {
  const pool = ensureAIPool();
  if (pool.length) {
    return Promise.allSettled(pool.map(slot => aiThinkOnSlot(slot, state, budgetMs))).then(settled => {
      const ok = [];
      for (const r of settled) if (r.status === 'fulfilled' && r.value) ok.push(r.value);
      if (!ok.length) throw new Error('AI worker pool failed');
      return ok.length === 1 ? ok[0] : mergeAIResults(ok);
    });
  }
  // フォールバック: Worker が使えない（file:// 等）ときはメインスレッドで。UI を守るため予算を短縮。
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(mainAIEngine(state).think(state, { budgetMs: Math.min(budgetMs, 1500), returnAllMoves: true, resignThreshold: 0.02 })); }
      catch (err) { reject(err); }
    }, 30);
  });
}
function cancelAI() {
  aiGeneration++;
  aiBusy = false;
  const ov = document.getElementById('aiOv');
  if (ov) ov.classList.add('hidden');
  const ovText = document.getElementById('aiOvText');
  if (ovText) ovText.textContent = 'AI 思考中...';
  aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
  aiPool = [];
  aiWaiters.forEach(waiter => waiter.reject(new Error('AI cancelled')));
  aiWaiters.clear();
}
function aiFallbackMove() {
  try { return aiChoose(); } catch (e) { return -1; }
}
function maybeAI() {
  if (G.over || aiBusy || (mode === 'online' && !isHost)) return;
  if (G.phase === 'setup') return;
  if (G.phase === 'dead') {
    const allAI = Array.from({length: G.playerCount || playerCount}, (_, i) => i + 1).every(p => aiSeatOf(p));
    if ((mode === 'local' || (mode === 'online' && isHost)) && allAI) { finishScore(); after(); }
    return;
  }
  if (G.phase !== 'playing' || !aiSeatOf(G.turn)) return;
  const gen = ++aiGeneration, turn = G.turn;
  const state = aiStateSnapshot(), budget = aiBudgetMs();
  aiBusy = true;
  const ovText = document.getElementById('aiOvText');
  if (ovText) ovText.textContent = 'AI 思考中...';
  document.getElementById('aiOv').classList.remove('hidden');
  const finish = result => {
    if (gen !== aiGeneration) return;
    aiBusy = false;
    document.getElementById('aiOv').classList.add('hidden');
    if (G.over || G.phase !== 'playing' || G.turn !== turn || !aiSeatOf(turn)) return;
    lastAIStats = result || null;
    let move = result && Number.isInteger(result.move) ? result.move : -3;
    if (move === -2) { resign(); after(); return; }
    // エンジンのパス判定(-1)は最終決定として尊重する（旧統合ではレガシーAIの
    // 着手で上書きされ、終盤に際限なく石を置き続ける原因だった）。
    if (move === -1) { doPass(); after(); return; }
    if (move < 0 || !play(move)) {
      const fb = aiFallbackMove();
      if (fb === -2) resign(); else if (fb < 0 || !play(fb)) doPass();
    }
    after();
  };
  setTimeout(() => {
    if (gen !== aiGeneration || !aiBusy) return;
    aiThink(state, budget).then(finish).catch(err => {
      if (gen !== aiGeneration) return;
      console.warn('[HEXAGO] AI engine failed; falling back to legacy AI:', err);
      finish({ move: aiFallbackMove() });
    });
  }, 120);
}
