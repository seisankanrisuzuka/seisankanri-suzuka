/* =====================================================================
   sync.js  生産管理システム（Firebase本番接続・無料枠最優先版）
   役割：①Firebase Authentication認証 & 社員照合
        ②タブ別権限判定 (Policy: 2ロール・15業務タブ)
        ③同時編集・競合防止 (バージョン厳格照合・自動マージ禁止・強制上書き禁止)
        ④タブ別リアルタイム同期 (無料枠優先・開いているタブのみ購読)
        ⑤操作履歴管理 (30日保存・手動一括削除・記録停止スイッチ)
        ⑥完了案件の90日経過後削除 (管理者専用・事前バックアップ対応)
        ⑦手動バックアップ・復元 (週1回・全コレクション対応)
   Firebase SDK: v13.2.0 (統一)
   ===================================================================== */
(function(){
'use strict';
const CFG = window.APP_CONFIG || {};

// Firebase設定の検証（モックモード禁止）
const HAS_FS = !!(CFG.firebase && CFG.firebase.apiKey && CFG.firebase.projectId);
if (!HAS_FS || CFG.mode !== 'firestore') {
  console.error('Firebase本番設定が無効です。public/firebase-config.js を確認してください。');
}

window.SYNC_ON = true;

/* ---------- 共通ユーティリティ ---------- */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TS = { __ts: true };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function getPath(o, p){ let t = o; for(const k of p){ if(t == null) return undefined; t = t[k]; } return t; }

/* 差分判定 */
function diff(base, cur, skip, path = [], ops = []){
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(cur || {})]);
  for(const k of keys){
    const p = [...path, k]; if(skip && skip(p)) continue;
    const b = base ? base[k] : undefined, c = cur ? cur[k] : undefined;
    if(c === undefined){ if(b !== undefined) ops.push({ p, del: true }); continue; }
    if(isObj(b) && isObj(c)) diff(b, c, skip, p, ops);
    else if(!eq(b, c)) ops.push({ p, v: clone(c) });
  }
  return ops;
}
function applyOps(doc, ops){
  const d = clone(doc) || {};
  for(const o of ops){
    let t = d;
    for(let i = 0; i < o.p.length - 1; i++){ if(!isObj(t[o.p[i]])) t[o.p[i]] = {}; t = t[o.p[i]]; }
    const k = o.p[o.p.length - 1];
    if(o.del) delete t[k]; else t[k] = clone(o.v);
  }
  return d;
}
const topFields = ops => [...new Set(ops.map(o => o.p[0]))];
function chain(map, name, fn){
  const prev = map[name] || Promise.resolve();
  const next = prev.catch(() => null).then(fn);
  map[name] = next;
  return next;
}

/* ---------- 15業務タブと権限（2ロール構成：管理者 admin / 一般社員 staff） ---------- */
const ALL_BUSINESS_TABS = [
  { id: 'dashboard', label: '全体状況' },
  { id: 'register', label: 'リスト登録' },
  { id: 'production', label: '工程管理' },
  { id: 'stage-cut', label: '切断工程' },
  { id: 'stage-bandsaw', label: 'バンドソー工程' },
  { id: 'stage-kiri', label: 'キリ穴工程' },
  { id: 'stage-shot', label: 'ショット工程' },
  { id: 'stage-bevel', label: '開先工程' },
  { id: 'stage-bend', label: '曲げ工程' },
  { id: 'loading', label: '積み込み' },
  { id: 'delivery', label: '配達表' },
  { id: 'delivery-search', label: '配達検索' },
  { id: 'plan', label: '生産計画' },
  { id: 'report', label: '実績集計' },
  { id: 'settings', label: 'データ管理' }
];
const STAGE_TABS = ['stage-cut', 'stage-bandsaw', 'stage-kiri', 'stage-shot', 'stage-bevel', 'stage-bend'];
const PROC_TAB = { '切断': 'stage-cut', 'バンドソー': 'stage-bandsaw', 'キリ': 'stage-kiri', 'ショット': 'stage-shot', '開先': 'stage-bevel', '曲げ': 'stage-bend' };
const TAB_IDS = ALL_BUSINESS_TABS.map(t => t.id);

const FIELD_GROUP = {};
['serial','sourceFile','due','dueStart','dueEnd','deliveryMethod','cutMethod','fullyOutsourced','job','customer','destination','processes','rows','processOrder','holeCount','holeDiameters','createdAt','delivered'].forEach(k => FIELD_GROUP[k] = 'info');
FIELD_GROUP.deliveryNote = 'note';
['processStatus','processDates','processDoneDates','processCompleted','processNotes'].forEach(k => FIELD_GROUP[k] = 'progress');
['pileCount','pileMap','loads'].forEach(k => FIELD_GROUP[k] = 'piles');
FIELD_GROUP.deliveryInfo = 'delivery';
const DERIVED = ['isOpen','closedDay'], STAMP = ['version','updatedAt','updatedBy','createdBy'], DELF = ['deleted','deletedAt','deletedBy'];
const ALL_LIST_FIELDS = [...Object.keys(FIELD_GROUP), ...DERIVED, ...STAMP, ...DELF];

const Policy = {
  active: s => !!s && s.active === true,
  admin: s => Policy.active(s) && s.role === 'admin',
  // 画面の閲覧・編集許可（管理者は全タブ、一般社員は許可タブのみ）
  hasTab: (s, tab) => Policy.active(s) && (s.role === 'admin' || (s.allowedTabs || []).includes(tab)),
  canAccessAny: (s, tabs) => Policy.active(s) && (s.role === 'admin' || tabs.some(t => (s.allowedTabs || []).includes(t))),
  view: (s, tabs) => Policy.canAccessAny(s, tabs),
  edit: (s, tabs) => Policy.canAccessAny(s, tabs),
  canDeleteList: s => Policy.admin(s) || (Policy.hasTab(s, 'register') && s.actions && s.actions.deleteList === true),

  /* 書き込み判定。拒否時は理由文、許可時は null */
  check(s, col, id, kind, changed) {
    if (!Policy.active(s)) return 'アカウントが無効です。管理者に連絡してください。';
    if (Policy.admin(s)) return null;

    if (col === 'lists') {
      if (kind === 'create') {
        return Policy.hasTab(s, 'register') ? null : 'リスト登録の権限がありません（「リスト登録」タブの許可が必要です）';
      }
      for (const f of changed) {
        if (STAMP.includes(f) || DERIVED.includes(f)) continue;
        if (DELF.includes(f)) {
          return Policy.canDeleteList(s) ? null : 'リストの削除権限がありません';
        }
        if (FIELD_GROUP[f] === 'info') {
          if (!Policy.hasTab(s, 'register')) return `「${f}」の変更には「リスト登録」タブの許可が必要です`;
        } else if (FIELD_GROUP[f] === 'note') {
          if (!Policy.hasTab(s, 'register') && !Policy.hasTab(s, 'delivery')) return `備考の変更には「リスト登録」または「配達表」の許可が必要です`;
        } else if (FIELD_GROUP[f] === 'progress') {
          const hasProg = Policy.hasTab(s, 'production') || STAGE_TABS.some(t => Policy.hasTab(s, t));
          if (!hasProg) return `工程進捗の変更権限がありません`;
        } else if (FIELD_GROUP[f] === 'piles') {
          const hasPile = Policy.hasTab(s, 'production') || Policy.hasTab(s, 'loading') || STAGE_TABS.some(t => Policy.hasTab(s, t));
          if (!hasPile) return `積込・山割当の変更権限がありません`;
        } else if (FIELD_GROUP[f] === 'delivery') {
          if (!Policy.hasTab(s, 'delivery')) return `納品情報の変更には「配達表」タブの許可が必要です`;
        }
      }
      return null;
    }
    if (col === 'events') {
      return Policy.hasTab(s, 'delivery') ? null : '配達表の編集権限がありません（「配達表」タブの許可が必要です）';
    }
    if (col === 'boards') {
      const tab = String(id).split('__')[0];
      return Policy.hasTab(s, tab) ? null : `このメモの編集権限がありません（「${tab}」タブの許可が必要です）`;
    }
    if (col === 'settings') {
      return Policy.hasTab(s, 'plan') ? null : '生産計画の編集権限がありません（「生産計画」タブの許可が必要です）';
    }
    if (col === 'counters') {
      return Policy.hasTab(s, 'register') ? null : '工程番号採番の権限がありません';
    }
    if (col === 'auditLogs') {
      return kind === 'create' ? null : (kind === 'delete' && Policy.admin(s) ? null : '操作履歴の改ざんはできません');
    }
    return '管理者のみ操作できます';
  }
};

/* ====================================================================
   Firebase Firestore アダプタ（SDK v13.2.0）
   ==================================================================== */
async function makeFirestore(){
  const SDK_VER = CFG.sdkVersion || '13.2.0';
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VER}/firebase-firestore.js`)
  ]);

  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(CFG.firebase);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);

  const toFsVal = v => (v && v.__ts) ? fsMod.serverTimestamp() : v;
  const fromFsDoc = d => {
    if (!d.exists()) return null;
    const v = d.data();
    for (const k of Object.keys(v)) {
      if (v[k] && typeof v[k].toDate === 'function') v[k] = v[k].toDate().toISOString();
    }
    return v;
  };

  return {
    kind: 'firestore',
    auth: {
      onChange: fn => authMod.onAuthStateChanged(auth, fn),
      signIn: (email, pw) => authMod.signInWithEmailAndPassword(auth, email, pw),
      signOut: () => authMod.signOut(auth),
      changePassword: pw => authMod.updatePassword(auth.currentUser, pw)
    },
    docGet: async (col, id) => fromFsDoc(await fsMod.getDoc(fsMod.doc(db, col, id))),
    colGet: async (col, f) => {
      const cr = fsMod.collection(db, col);
      const q = f ? fsMod.query(cr, fsMod.where(f.field, f.op, f.value)) : cr;
      const snap = await fsMod.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, data: fromFsDoc(d) }));
    },
    docWatch: (col, id, onNext, onErr) => fsMod.onSnapshot(fsMod.doc(db, col, id), d => onNext(fromFsDoc(d)), onErr),
    colWatch: (col, f, onNext, onErr) => {
      const cr = fsMod.collection(db, col);
      const q = f ? fsMod.query(cr, fsMod.where(f.field, f.op, f.value)) : cr;
      return fsMod.onSnapshot(q, s => onNext(s.docs.map(d => ({ id: d.id, data: fromFsDoc(d) }))), onErr);
    },
    docDelete: async (col, id) => fsMod.deleteDoc(fsMod.doc(db, col, id)),
    runTx: fn => fsMod.runTransaction(db, async tx => {
      return fn({
        get: async (col, id) => fromFsDoc(await tx.get(fsMod.doc(db, col, id))),
        set: (col, id, val) => {
          const v = clone(val);
          Object.keys(v).forEach(k => { v[k] = toFsVal(v[k]); });
          tx.set(fsMod.doc(db, col, id), v);
        },
        update: (col, id, ops) => {
          const map = {};
          ops.forEach(o => { map[o.p.join('.')] = o.del ? fsMod.deleteField() : toFsVal(o.v); });
          tx.update(fsMod.doc(db, col, id), map);
        },
        delete: (col, id) => tx.delete(fsMod.doc(db, col, id))
      });
    })
  };
}

/* ====================================================================
   状態管理・変換ロジック
   ==================================================================== */
const S = {
  store: null, uid: null, staff: null,
  B: null, started: false,
  base: { lists: new Map(), events: new Map(), boards: new Map(), settings: null, info: new Map() },
  raw: new Map(),
  pendingCreate: new Set(),
  activeTab: 'dashboard',
  tabUnsubs: [],       // 現在開いているタブ限定の購読解除関数リスト
  listUnsubs: [],      // リスト購読解除関数リスト
  staffUnsub: null,
  qres: {},
  q: { lists: null, delivery: null, settings: null },
  enableAudit: true,   // 操作履歴保存スイッチ
  dayTimer: null, day: null, changingPw: false
};

const idToEmail = id => id.includes('@') ? id : `${id}@${CFG.idDomain || 'seisankanri-suzuka-aa08c.firebaseapp.com'}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const toast = (m, kind) => {
  let b = document.getElementById('syncToast');
  if(!b){ b = document.createElement('div'); b.id = 'syncToast'; document.body.appendChild(b); }
  const el = document.createElement('div'); el.className = 'sync-toast ' + (kind || ''); el.textContent = m;
  b.appendChild(el); setTimeout(() => { el.remove(); }, kind === 'err' ? 6000 : 3500);
};

/* 画面の List オブジェクト ↔ Firestore ドキュメント */
function listToDoc(l){
  const d = {};
  ALL_LIST_FIELDS.forEach(k => { if(l[k] !== undefined) d[k] = clone(l[k]); });
  d.pileMap = d.pileMap || {};
  (l.pileItems || []).forEach(p => { d.pileMap[p.id] = { pile: p.pile, pos: p.pos }; });
  d.isOpen = !(l.delivered || (l.processCompleted && Object.values(l.processCompleted).every(Boolean)));
  d.closedDay = d.isOpen ? '' : ((l.processDoneDates && Object.values(l.processDoneDates).sort().pop()) || today());
  return d;
}
function docToList(d, selMap){
  const l = clone(d) || {};
  const piles = {};
  if(l.pileMap){
    l.pileItems = [];
    const done = l.processCompleted && l.processCompleted['切断'];
    const grps = {};
    (l.rows || []).forEach(r => {
      const mat = r[1] || '', sz = r[2] || '';
      const key = mat.startsWith('PL') ? `${mat}__${sz.replace(/[*xX].*$/, '')}` : `${mat}__${sz}`;
      grps[key] = grps[key] || []; grps[key].push(r);
    });
    let idx = 1;
    for(const key of Object.keys(grps)){
      const r0 = grps[key][0], q = grps[key].reduce((a, r) => a + (+r[4] || 0), 0);
      const id = `${l.serial}-${idx++}`;
      const sv = l.pileMap[id] || {};
      const p = { id, serial: l.serial, job: l.job, customer: l.customer, destination: l.destination, material: r0[1] || '', spec: r0[2] || '', qty: q, weight: 0, pile: sv.pile || '未割当', pos: sv.pos || idx, cutCompleted: !!done };
      if(selMap && selMap[id]) p._selected = true;
      piles[p.pile] = piles[p.pile] || []; piles[p.pile].push(p);
      l.pileItems.push(p);
    }
  }
  return l;
}
const skipLocal = p => p[0] === 'pileItems';
const SERVER_STRIP = ['deleted','deletedAt','deletedBy','version','updatedAt','updatedBy','createdBy'];
function stripServer(d){ const x = clone(d); SERVER_STRIP.forEach(k => delete x[k]); return x; }

function allowed(col, id, kind, ops){
  const err = Policy.check(S.staff, col, id, kind, kind === 'create' ? [] : topFields(ops));
  if(err){ toast('この操作はできません：' + err, 'err'); return false; }
  return true;
}

// 必要最小限の操作履歴（書き込み過剰防止）
function auditDoc(col, id, version, op, ops, base){
  return {
    at: TS,
    by: S.uid,
    byId: (S.staff && S.staff.staffId) || S.uid,
    col,
    docId: id,
    op,
    version,
    fields: topFields(ops || [])
  };
}
const logId = (col, id, v) => `${col}__${id}__${v}`;

/* ---------- 同時編集対策・厳格なバージョン照合 (自動マージ禁止・強制上書き禁止) ---------- */
async function txUpdate(tx, col, id, ops, base, pre){
  const cur = pre !== undefined ? pre : await tx.get(col, id);
  if(!cur) throw Object.assign(new Error('対象データが存在しません'), { code: 'missing' });

  // 厳格なバージョン照合：編集開始時の base.version とサーバーの cur.version を比較
  const curVer = cur.version || 0;
  const baseVer = (base && base.version) || 0;

  // 編集開始後に対象データが更新されていた場合、自動マージせず保存を拒否
  if(curVer !== baseVer){
    const err = new Error('conflict');
    err.code = 'conflict';
    err.col = col;
    err.id = id;
    err.cur = cur;
    err.base = base;
    err.curVer = curVer;
    err.baseVer = baseVer;
    err.updatedBy = cur.updatedBy || '他の社員';
    err.updatedAt = cur.updatedAt;
    throw err;
  }

  const nv = curVer + 1;
  tx.update(col, id, [
    ...ops,
    { p: ['version'], v: nv },
    { p: ['updatedAt'], v: TS },
    { p: ['updatedBy'], v: S.uid }
  ]);
  if(S.enableAudit){
    tx.set('auditLogs', logId(col, id, nv), auditDoc(col, id, nv, 'update', ops, cur));
  }
  return { latest: applyOps(cur, ops), version: nv };
}

async function txCreate(tx, col, id, doc, pre){
  const cur = pre !== undefined ? pre : await tx.get(col, id);
  if(cur) throw Object.assign(new Error('すでに登録されています'), { code: 'exists' });
  tx.set(col, id, { ...doc, deleted: false, version: 1, createdBy: S.uid, updatedAt: TS, updatedBy: S.uid });
  if(S.enableAudit){
    tx.set('auditLogs', logId(col, id, 1), auditDoc(col, id, 1, 'create', [], {}));
  }
}

function fail(e, what){
  console.error(what, e);
  if(e && e.code === 'conflict'){
    showConflictDialog(e);
    return;
  }
  const m = String((e && e.message) || e);
  toast((/permission/i.test(m) ? '権限がないため保存できませんでした。' : '保存に失敗しました。') + ' (' + what + ') ' + m.slice(0, 120), 'err');
  resync();
}

/* ---------- 競合検知ダイアログ（強制上書き不可・最新データ読み直し） ---------- */
function showConflictDialog(info){
  let dlg = document.getElementById('conflictDialog');
  if(!dlg){
    dlg = document.createElement('div');
    dlg.id = 'conflictDialog';
    dlg.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.8);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
    document.body.appendChild(dlg);
  }
  const who = info.updatedBy || '他の社員';
  const when = info.updatedAt ? new Date(info.updatedAt).toLocaleTimeString('ja-JP') : '直前';

  dlg.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:min(94vw,540px);padding:24px;box-shadow:0 25px 50px -12px rgba(0,0,0,.3);border:2px solid #ef4444;box-sizing:border-box">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:28px">⚠️</span>
        <h2 style="margin:0;font-size:18px;font-weight:800;color:#991b1b">他の社員が先に更新しました</h2>
      </div>
      <p style="margin:0 0 14px;color:#1e293b;font-size:14px;line-height:1.6">
        工程番号 <b>${esc(info.id)}</b> は、あなたが編集中に <b>${esc(who)}</b> さんによって <b>${esc(when)}</b> に更新されました。
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;color:#7f1d1d">
        <b>【保存できません】</b><br>
        データの上書き事故を防ぐため、保存は拒否されました。<br>
        最新データを読み直してから、再度編集してください。
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="cfReloadBtn" type="button" style="padding:12px;font-size:14px;font-weight:700;background:#2563eb;color:#fff;border:0;border-radius:10px;cursor:pointer">
          🔄 最新データを読み直す
        </button>
        <button id="cfCloseBtn" type="button" style="padding:8px;font-size:13px;color:#64748b;background:none;border:0;cursor:pointer;text-decoration:underline">
          閉じる
        </button>
      </div>
    </div>
  `;
  dlg.style.display = 'flex';

  document.getElementById('cfReloadBtn').onclick = () => {
    dlg.style.display = 'none';
    const latestDoc = stripServer(info.cur);
    S.base.lists.set(info.id, latestDoc);
    const ls = docToList(latestDoc);
    S.B.normalize && S.B.normalize(ls);
    const all = S.B.getLists().slice();
    const idx = all.findIndex(l => String(l.serial) === String(info.id));
    if(idx >= 0) all[idx] = ls; else all.push(ls);
    S.B.setLists(all);
    S.B.renderSoon();
    toast(`工程番号 ${info.id} の最新データを読み直しました。再編集を行ってください。`, 'warn');
  };

  document.getElementById('cfCloseBtn').onclick = () => {
    dlg.style.display = 'none';
    resync();
  };
}

/* ---------- リスト：差分送信 ---------- */
function pushLists(){ return chain(S.q, 'lists', async () => {
  const B = S.B, L = B.getLists(); B.ensure && L.forEach(B.ensure);
  const cur = new Map(L.map(l => [String(l.serial), listToDoc(l)]));
  const jobs = [];
  for(const [id, doc] of cur){
    const b = S.base.lists.get(id);
    if(!b) jobs.push({ kind: 'create', id, doc });
    else {
      const ops = diff(b, doc, skipLocal);
      if(ops.length) jobs.push({ kind: 'update', id, ops, base: b });
    }
  }
  for(const [id, b] of S.base.lists) if(!cur.has(id)) jobs.push({ kind: 'delete', id, base: b });
  if(!jobs.length) return;

  for(const j of jobs){
    const ops = j.kind === 'delete' ? [{ p: ['deleted'], v: true }] : j.ops;
    if(!allowed('lists', j.id, j.kind === 'delete' ? 'update' : j.kind, ops)) return resync();
  }

  try {
    for(let i = 0; i < jobs.length; i += 5){
      const chunk = jobs.slice(i, i + 5);
      const res = await S.store.runTx(async tx => {
        const pre = [];
        for(const j of chunk) pre.push(await tx.get('lists', j.id));
        const out = [];
        for(let k = 0; k < chunk.length; k++){
          const j = chunk[k];
          if(j.kind === 'create'){
            await txCreate(tx, 'lists', j.id, j.doc, pre[k]);
            out.push({ j, latest: j.doc });
          } else if(j.kind === 'update'){
            if(!pre[k] || pre[k].deleted){ out.push({ j, gone: true }); continue; }
            out.push({ j, ...await txUpdate(tx, 'lists', j.id, j.ops, j.base, pre[k]) });
          } else {
            if(!pre[k]) continue;
            const nv = (pre[k].version || 0) + 1;
            tx.update('lists', j.id, [
              { p: ['deleted'], v: true },
              { p: ['deletedAt'], v: TS },
              { p: ['deletedBy'], v: S.uid },
              { p: ['version'], v: nv },
              { p: ['updatedAt'], v: TS },
              { p: ['updatedBy'], v: S.uid }
            ]);
            if(S.enableAudit){
              tx.set('auditLogs', logId('lists', j.id, nv), auditDoc('lists', j.id, nv, 'delete', [], pre[k]));
            }
            out.push({ j, deleted: true });
          }
        }
        return out;
      });

      for(const r of res){
        const id = r.j.id;
        if(r.deleted){ S.base.lists.delete(id); S.raw.delete(id); }
        else if(r.gone){ toast(`工程番号 ${id} は他社員に削除されています`, 'err'); }
        else {
          S.pendingCreate.delete(id);
          S.base.lists.set(id, r.j.kind === 'create' ? clone(r.j.doc) : stripServer(r.latest));
        }
      }
    }
  } catch(e) {
    fail(e, 'リスト');
  }
});}

/* ---------- 配達表・メモの差分送信 ---------- */
const metaKeys = m => Object.keys(m || {});
function evDoc(e, meta){
  const d = clone(e);
  d.slip = (meta && meta['E:'+e.id] && meta['E:'+e.id].slip) || '';
  d.sales = (meta && meta['E:'+e.id] && meta['E:'+e.id].sales) || '';
  d.date = d.date || '';
  return d;
}
function boardDocFrom(key, arr){
  const memos = {};
  (arr || []).forEach((x, i) => {
    if(x && x.type === 'memo') memos[x.id] = { text: x.text || '', pos: i };
    else if(x && x.memo !== undefined) memos[x.key] = { text: x.memo || '', pos: i };
  });
  return memos;
}
function boardMeta(key){
  if(key === 'delivery') return { id: 'delivery', tab: 'delivery' };
  const [proc, group] = String(key).split('|');
  const tab = PROC_TAB[proc];
  return tab ? { id: `${tab}__${group || ''}`, tab } : null;
}

function pushDelivery(){ return chain(S.q, 'delivery', async () => {
  const B = S.B;
  const meta = B.getMeta(), evs = B.getEvents();
  const jobs = [];

  for(const k of metaKeys(meta)){
    if(!k.startsWith('L:')) continue;
    const id = k.slice(2);
    const b = S.base.lists.get(id);
    if(!b) continue;
    const m = meta[k] || {};
    const baseInfo = (S.base.info && S.base.info.get(id)) || {};
    const ops = [];
    ['slip','sales'].forEach(f => { if((m[f] || '') !== (baseInfo[f] || '')) ops.push({ p: ['deliveryInfo', f], v: m[f] || '' }); });
    if(ops.length) jobs.push({ col: 'lists', id, ops, base: { deliveryInfo: baseInfo } });
  }

  const curEv = new Map(evs.map(e => [String(e.id), evDoc(e, meta)]));
  for(const [id, doc] of curEv){
    const b = S.base.events.get(id);
    if(!b) jobs.push({ col: 'events', id, create: true, doc });
    else {
      const ops = diff(b, doc);
      if(ops.length) jobs.push({ col: 'events', id, ops, base: b });
    }
  }

  const boards = [{ key: 'delivery', arr: B.getDeliveryBoard() }, ...Object.entries(B.getStageBoard() || {}).map(([key, arr]) => ({ key, arr }))];
  for(const bd of boards){
    const bm = boardMeta(bd.key); if(!bm) continue;
    const memos = boardDocFrom(bd.key, bd.arr);
    const b = S.base.boards.get(bm.id);
    if(!b){ if(Object.keys(memos).length) jobs.push({ col: 'boards', id: bm.id, create: true, doc: { tab: bm.tab, key: bd.key, memos } }); }
    else {
      const ops = diff({ memos: b.memos || {} }, { memos }, null);
      if(ops.length) jobs.push({ col: 'boards', id: bm.id, ops, base: { memos: b.memos || {} } });
    }
  }

  if(!jobs.length) return;
  for(const j of jobs){ if(!allowed(j.col, j.id, j.create ? 'create' : 'update', j.ops || [])) return resync(); }

  try {
    for(let i = 0; i < jobs.length; i += 5){
      const chunk = jobs.slice(i, i + 5);
      const res = await S.store.runTx(async tx => {
        const pre = []; for(const j of chunk) pre.push(await tx.get(j.col, j.id));
        const out = [];
        for(let k = 0; k < chunk.length; k++){
          const j = chunk[k];
          if(j.create){
            if(pre[k]){
              const ops = diff(pre[k], j.doc);
              if(ops.length) out.push({ j, ...await txUpdate(tx, j.col, j.id, ops, pre[k], pre[k]) });
              else out.push({ j, latest: pre[k] });
            } else {
              await txCreate(tx, j.col, j.id, j.doc, pre[k]);
              out.push({ j, latest: j.doc });
            }
          } else {
            if(!pre[k]){ out.push({ j, gone: true }); continue; }
            out.push({ j, ...await txUpdate(tx, j.col, j.id, j.ops, j.base, pre[k]) });
          }
        }
        return out;
      });

      for(const r of res){
        if(r.gone) continue;
        const j = r.j;
        if(j.col === 'lists'){
          S.base.info = S.base.info || new Map();
          S.base.info.set(j.id, { ...(S.base.info.get(j.id) || {}), ...Object.fromEntries(j.ops.map(o => [o.p[1], o.v])) });
        } else if(j.col === 'events'){
          S.base.events.set(j.id, clone(r.latest && stripEv(r.latest) || j.doc));
        } else if(j.col === 'boards'){
          S.base.boards.set(j.id, { tab: (r.latest || j.doc).tab, key: (r.latest || j.doc).key, memos: clone((r.latest || j.doc).memos || {}) });
        }
      }
    }
  } catch(e) {
    fail(e, '配達表・メモ');
  }
});}
const stripEv = d => { const x = clone(d); SERVER_STRIP.forEach(k => delete x[k]); return x; };
function pushStage(){ return pushDelivery(); }

/* ---------- 生産計画（切断速度）差分送信 ---------- */
function pushSettings(){ return chain(S.q, 'settings', async () => {
  const items = S.B.getCutSpeeds();
  if(S.base.settings && eq(S.base.settings.items, items)) return;
  if(!allowed('settings', 'cutSpeeds', 'update', [{ p: ['items'], v: items }])) return resync();
  try {
    await S.store.runTx(async tx => {
      const cur = await tx.get('settings', 'cutSpeeds');
      if(!cur) await txCreate(tx, 'settings', 'cutSpeeds', { items });
      else await txUpdate(tx, 'settings', 'cutSpeeds', [{ p: ['items'], v: items }], cur, cur);
    });
    S.base.settings = { items: clone(items) };
  } catch(e) {
    fail(e, '切断速度');
  }
});}

/* ---------- 工程番号採番（重複完全防止） ---------- */
async function nextSerial(){
  if(!Policy.hasTab(S.staff, 'register')) throw new Error('リスト登録の権限がありません（「リスト登録」タブの許可が必要です）');
  let n = 0;
  await S.store.runTx(async tx => {
    const c = await tx.get('counters', 'serial');
    let last = (c && c.last) || 0;
    for(let t = 0; t < 200; t++){
      last++;
      if(last > 99999) throw new Error('工程番号の上限（S99999）に達しました');
      const ex = await tx.get('lists', 'S' + String(last).padStart(5, '0'));
      if(!ex) break;
    }
    if(c) tx.update('counters', 'serial', [{ p: ['last'], v: last }]);
    else tx.set('counters', 'serial', { last });
    n = last;
  });
  const id = 'S' + String(n).padStart(5, '0');
  S.pendingCreate.add(id);
  return id;
}

/* ---------- リアルタイム受信：データ反映 ---------- */
function ingestLists(union){
  const B = S.B; const prevMap = new Map(B.getLists().map(l => [String(l.serial), l]));
  const out = []; const seen = new Set(); let changed = false;
  union.forEach((sd, id) => {
    seen.add(id); const rawStr = JSON.stringify(sd);
    const prev = prevMap.get(id);
    if(S.raw.get(id) === rawStr && prev){ out.push(prev); return; }
    changed = true; S.raw.set(id, rawStr);
    const server = stripServer(sd);
    const old = S.base.lists.get(id);
    const pend = (prev && old) ? diff(old, listToDoc(prev), skipLocal) : [];
    const sel = {}; if(prev)(prev.pileItems || []).forEach(p => { if(p._selected) sel[p.id] = true; });
    const ls = docToList(server); B.normalize && B.normalize(ls);
    const baseDoc = listToDoc(ls); S.base.lists.set(id, baseDoc);
    const merged = pend.length ? docToList(applyOps(baseDoc, pend), sel) : docToList(baseDoc, sel);
    if(sd.deliveryInfo){
      S.base.info = S.base.info || new Map();
      S.base.info.set(id, { slip: sd.deliveryInfo.slip || '', sales: sd.deliveryInfo.sales || '' });
      const m = B.getMeta(); const k = 'L:' + id; const cur = m[k] || {};
      if(cur.slip !== (sd.deliveryInfo.slip || '') || cur.sales !== (sd.deliveryInfo.sales || '')){
        m[k] = { slip: sd.deliveryInfo.slip || '', sales: sd.deliveryInfo.sales || '' };
        B.setMeta(m);
      }
    }
    out.push(merged);
  });
  prevMap.forEach((l, id) => { if(!seen.has(id) && (S.pendingCreate.has(id) || !S.base.lists.has(id))) out.push(l); });
  for(const id of [...S.base.lists.keys()]){
    if(!seen.has(id) && !S.pendingCreate.has(id)){ S.base.lists.delete(id); S.raw.delete(id); changed = true; }
  }
  out.sort((a, b) => String(a.serial).localeCompare(String(b.serial)));
  if(changed || out.length !== B.getLists().length){ B.setLists(out); B.renderSoon(); }
}

function ingestEvents(docs){
  const B = S.B; const prevEv = new Map(B.getEvents().map(e => [String(e.id), e])); const meta = B.getMeta(); const out = []; let ch = false;
  docs.forEach(({ id, data }) => {
    if(data.deleted) return;
    const sd = stripEv(data); const old = S.base.events.get(id); const prev = prevEv.get(id);
    const pend = (prev && old) ? diff(old, evDoc(prev, meta)) : [];
    S.base.events.set(id, sd);
    const merged = pend.length ? applyOps(sd, pend) : sd;
    const e = clone(merged); const slip = e.slip, sales = e.sales; delete e.slip; delete e.sales; out.push(e);
    const k = 'E:' + id;
    if(slip || sales){
      const m = meta[k] || {};
      if(m.slip !== slip || m.sales !== sales){ meta[k] = { slip: slip || '', sales: sales || '' }; ch = true; }
    }
  });
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if(ch) B.setMeta(meta); B.setEvents(out); B.renderSoon();
}

function ingestBoards(docs){
  const B = S.B; const stage = B.getStageBoard() || {}; let dboard = B.getDeliveryBoard() || [];
  docs.forEach(({ id, data }) => {
    const old = S.base.boards.get(id); const key = data.key; const localArr = key === 'delivery' ? dboard : (stage[key] || []);
    const localMemos = boardDocFrom(key, localArr); const pend = old ? diff({ memos: old.memos || {} }, { memos: localMemos }) : [];
    const memos = applyOps({ memos: data.memos || {} }, pend).memos || {};
    S.base.boards.set(id, { tab: data.tab, key, memos: clone(data.memos || {}) });
    const arr = localArr.filter(x => !(x && (x.type === 'memo' || x.memo !== undefined)));
    Object.entries(memos).sort((a, b) => (a[1].pos || 0) - (b[1].pos || 0)).forEach(([mid, m]) => {
      const item = key === 'delivery' ? { key: mid, memo: m.text } : { type: 'memo', id: mid, text: m.text };
      arr.splice(Math.min(m.pos || 0, arr.length), 0, item);
    });
    if(key === 'delivery') dboard = arr; else stage[key] = arr;
  });
  B.setStageBoard(stage); B.setDeliveryBoard(dboard); B.renderSoon();
}

/* ---------- 無料枠最優先・タブ限定リアルタイム購読 ---------- */
function stopData(){
  S.listUnsubs.forEach(f => { try{ f(); }catch(e){} }); S.listUnsubs = [];
  S.tabUnsubs.forEach(f => { try{ f(); }catch(e){} }); S.tabUnsubs = [];
  clearInterval(S.dayTimer);
}

function startLists(){
  S.listUnsubs.forEach(f => { try{ f(); }catch(e){} }); S.listUnsubs = []; S.qres = {};
  S.day = today();
  const apply = () => {
    const u = new Map();
    Object.values(S.qres).forEach(m => m.forEach((d, id) => { if(!d.deleted) u.set(id, d); }));
    ingestLists(u);
  };
  const sub = (key, filter) => {
    S.listUnsubs.push(S.store.colWatch('lists', filter, docs => {
      S.qres[key] = new Map(docs.map(d => [d.id, d.data]));
      apply();
    }, e => toast('リスト取得に失敗：' + (e.message || e), 'err')));
  };
  // 無料枠節約：未完了案件または本日以降完了案件のみを購読
  sub('open', { field: 'isOpen', op: '==', value: true });
  sub('recent', { field: 'closedDay', op: '>=', value: S.day });
}

// タブ切り替え時の購読制御（開いているタブに必要なデータだけ購読、前タブの購読は解除）
function switchTab(tabId){
  S.activeTab = tabId || 'dashboard';
  // 前のタブ専用の購読を解除
  S.tabUnsubs.forEach(f => { try{ f(); }catch(e){} }); S.tabUnsubs = [];

  if(!S.store || !S.staff) return;

  // 1. 社員管理タブ
  if(tabId === 'staff'){
    if(Policy.admin(S.staff)){
      S.tabUnsubs.push(S.store.colWatch('staff', null, renderStaffAdmin, e => toast('社員一覧取得に失敗：' + (e.message || e), 'err')));
    }
    return;
  }

  // 2. 配達表タブ
  if(tabId === 'delivery'){
    const cutoff = (() => { const d = new Date(); d.setDate(d.getDate() - 60); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    S.tabUnsubs.push(S.store.colWatch('events', { field: 'date', op: '>=', value: cutoff }, ingestEvents, e => toast('配送イベント取得に失敗：' + (e.message || e), 'err')));
    S.tabUnsubs.push(S.store.colWatch('boards', { field: 'tab', op: '==', value: 'delivery' }, ingestBoards, e => toast('配達メモ取得に失敗：' + (e.message || e), 'err')));
    if(!S.listUnsubs.length) startLists();
    return;
  }

  // 3. 各工程タブ（当該工程のメモ表のみを購読）
  if(STAGE_TABS.includes(tabId)){
    S.tabUnsubs.push(S.store.colWatch('boards', { field: 'tab', op: '==', value: tabId }, ingestBoards, e => toast('工程メモ取得に失敗：' + (e.message || e), 'err')));
    if(!S.listUnsubs.length) startLists();
    return;
  }

  // 4. 生産計画タブ
  if(tabId === 'plan'){
    S.tabUnsubs.push(S.store.docWatch('settings', 'cutSpeeds', d => {
      if(d && Array.isArray(d.items)){ S.base.settings = { items: clone(d.items) }; S.B.setCutSpeeds(clone(d.items)); S.B.renderSoon(); }
    }, e => toast('設定取得に失敗：' + (e.message || e), 'err')));
    if(!S.listUnsubs.length) startLists();
    return;
  }

  // 5. リスト・積込・全体状況タブ
  if(['dashboard', 'register', 'production', 'loading'].includes(tabId)){
    if(!S.listUnsubs.length) startLists();
    return;
  }

  // 6. 実績集計・配達検索・データ管理タブ（常時購読不要）
}

function resync(){
  const B = S.B; S.raw.clear(); S.pendingCreate.clear(); B.setLists([]); S.base.lists.clear();
  startLists();
  switchTab(S.activeTab);
}

/* ====================================================================
   画面：ログイン／認証／タブ権限
   ==================================================================== */
function showConnectionError(e){
  let errBox = document.getElementById('firebaseFatalError');
  if(!errBox){
    errBox = document.createElement('div');
    errBox.id = 'firebaseFatalError';
    errBox.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.95);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box';
    document.body.appendChild(errBox);
  }
  const m = String((e && e.message) || e);
  errBox.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;max-width:520px;border:2px solid #dc2626;box-shadow:0 25px 50px rgba(0,0,0,.5);text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🚫</div>
      <h2 style="margin:0 0 10px;font-size:20px;color:#991b1b;font-weight:800">Firebase本番接続エラー</h2>
      <p style="color:#334155;font-size:14px;line-height:1.6;margin:0 0 16px">
        Firebase本番データベースへの接続に失敗しました。<br>
        データの保護のため、保存および更新を一時停止しています。
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:8px;font-size:12px;color:#b91c1c;word-break:break-all;text-align:left;margin-bottom:16px">
        ${esc(m)}
      </div>
      <button onclick="window.location.reload()" style="padding:10px 20px;font-size:14px;font-weight:700;background:#2563eb;color:#fff;border:0;border-radius:8px;cursor:pointer">
        ページを再読み込みして再接続
      </button>
    </div>
  `;
}

function ui(){
  if(document.getElementById('authOverlay')) return;
  const st = document.createElement('style'); st.textContent = `
  body.locked>*:not(#authOverlay):not(#syncToast):not(#conflictDialog):not(#firebaseFatalError){display:none!important}
  body:not(.locked) #authOverlay{display:none!important}
  body.locked #authOverlay{display:flex!important}
  #authOverlay{position:fixed;inset:0;background:rgba(15,23,42,.85);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;z-index:5000;padding:16px;box-sizing:border-box}
  #authOverlay .card{background:#fff;border-radius:20px;padding:28px;width:min(94vw,420px);box-shadow:0 20px 45px -10px rgba(0,0,0,.35);border:1px solid #cbd5e1;box-sizing:border-box}
  #authOverlay h1{font-size:22px;margin:0;font-weight:800;color:#0f172a;letter-spacing:-0.02em}
  #authOverlay p{margin:0 0 16px;color:#64748b;font-size:13px}
  #authOverlay label{display:block;font-size:12px;font-weight:700;color:#334155;margin:12px 0 4px}
  #authOverlay input{width:100%;box-sizing:border-box;padding:11px 14px;font-size:15px;border:1.5px solid #cbd5e1;border-radius:10px;background:#f8fafc;outline:none;transition:border-color .15s}
  #authOverlay input:focus{border-color:#2563eb;background:#fff;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  #authOverlay .btn-primary{width:100%;box-sizing:border-box;margin-top:16px;padding:12px;font-size:15px;font-weight:700;background:#2563eb;color:#fff;border:0;border-radius:10px;cursor:pointer;transition:background .15s}
  #authOverlay .btn-primary:hover{background:#1d4ed8}
  #authOverlay .btn-secondary{width:100%;box-sizing:border-box;margin-top:8px;padding:10px;font-size:13px;font-weight:600;background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;border-radius:10px;cursor:pointer;transition:background .15s}
  #authOverlay .btn-secondary:hover{background:#e2e8f0}
  #authOverlay .msg{margin-top:12px;color:#b91c1c;font-size:13px;min-height:18px;line-height:1.4}
  #syncToast{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:6000;display:flex;flex-direction:column;gap:6px;width:min(94vw,520px)}
  .sync-toast{background:#0f172a;color:#fff;padding:10px 14px;border-radius:10px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.3)}
  .sync-toast.err{background:#b91c1c}.sync-toast.warn{background:#b45309}
  .user-box{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:#fff}
  .user-box button{background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer}
  body.not-admin .admin-only{display:none!important}
  .page.forbidden{display:none!important}
  `;
  document.head.appendChild(st);

  const ov = document.createElement('div'); ov.id = 'authOverlay';
  ov.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <h1>生産管理システム</h1>
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe">本番認証</span>
    </div>
    <p>Firebase Authentication 社員ログイン</p>

    <div id="authForm">
      <label>社員ID または メールアドレス</label>
      <input id="authId" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="例: suzuki">
      <label>パスワード</label>
      <input id="authPw" type="password" autocomplete="current-password" placeholder="パスワードを入力">
      <button id="authBtn" type="button" class="btn-primary">ログイン</button>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed #e2e8f0;text-align:center">
        <a href="/production_system_free_plan.zip" download="production_system_free_plan.zip" style="font-size:12px;color:#2563eb;text-decoration:underline;font-weight:700">
          📦 全ファイル一式（ZIPアーカイブ）をダウンロード
        </a>
      </div>
    </div>

    <!-- 初回／変更時のパスワード設定フォーム -->
    <div id="authPwForm" style="display:none">
      <p id="authPwHint" style="font-size:13px;color:#334155;margin-bottom:10px">新しいパスワード（10文字以上）を設定してください。</p>
      <label>新しいパスワード</label>
      <input id="authNew1" type="password" autocomplete="new-password" placeholder="10文字以上">
      <label>もう一度入力</label>
      <input id="authNew2" type="password" autocomplete="new-password" placeholder="もう一度入力">
      <button id="authPwBtn" type="button" class="btn-primary">パスワードを設定して開始</button>
      <button id="authPwCancelBtn" type="button" class="btn-secondary">← ログイン画面に戻る</button>
    </div>

    <div class="msg" id="authMsg"></div>
  </div>`;
  document.body.appendChild(ov);

  document.getElementById('authBtn').onclick = doLogin;
  document.getElementById('authPwBtn').onclick = doChangePw;
  document.getElementById('authPwCancelBtn').onclick = () => {
    if(S.changingPw && S.staff){
      S.changingPw = false;
      document.body.classList.remove('locked');
      document.getElementById('authPwForm').style.display = 'none';
      return;
    }
    if(S.store && S.store.auth) S.store.auth.signOut().catch(() => {});
    showLogin();
  };

  document.getElementById('authPw').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
  document.getElementById('authId').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
}

const msg = t => { const m = document.getElementById('authMsg'); if(m) m.textContent = t || ''; };

async function doLogin(){
  const idEl = document.getElementById('authId'), pwEl = document.getElementById('authPw');
  if(!idEl || !pwEl) return;
  const rawId = idEl.value.trim().toLowerCase();
  const rawPw = pwEl.value.trim();
  if(!rawId || !rawPw){ msg('社員IDとパスワードを入力してください'); return; }
  msg('');
  const btn = document.getElementById('authBtn');
  if(btn) btn.disabled = true;
  try {
    if(!S.store){
      S.store = await makeFirestore();
      initAuthListener();
    }
    await S.store.auth.signIn(idToEmail(rawId), rawPw);
  } catch(e) {
    console.error('Login error:', e);
    msg('社員IDまたはパスワードが正しくありません');
  } finally {
    if(btn) btn.disabled = false;
  }
}

async function doChangePw(){
  const a = document.getElementById('authNew1').value, b = document.getElementById('authNew2').value;
  if(a.length < 10){ msg('パスワードは10文字以上にしてください'); return; }
  if(a !== b){ msg('2つのパスワードが一致しません'); return; }
  try {
    await S.store.auth.changePassword(a);
    const cur = await S.store.docGet('staff', S.uid);
    const nv = (cur.version || 0) + 1;
    await S.store.runTx(async tx => {
      tx.update('staff', S.uid, [
        { p: ['mustChangePassword'], v: false },
        { p: ['version'], v: nv },
        { p: ['updatedAt'], v: TS },
        { p: ['updatedBy'], v: S.uid }
      ]);
    });
    msg(''); S.staff.mustChangePassword = false; S.changingPw = false; enter();
  } catch(e) {
    msg('パスワードを変更できませんでした：' + (e.code || e.message));
  }
}

function showLogin(m){
  stopData(); S.started = false;
  const B = S.B;
  if(B){
    B.setLists([]); B.setEvents([]); B.setMeta({}); B.setStageBoard({}); B.setDeliveryBoard([]);
    S.base.lists.clear(); S.base.events.clear(); S.base.boards.clear(); S.raw.clear(); B.renderSoon();
  }
  document.body.classList.add('locked');
  const ov = document.getElementById('authOverlay');
  if(ov) ov.style.display = 'flex';
  const authForm = document.getElementById('authForm');
  const authPwForm = document.getElementById('authPwForm');
  if(authForm) authForm.style.display = '';
  if(authPwForm) authPwForm.style.display = 'none';
  msg(m || '');
}

function applyPerms(){
  const st = S.staff, adm = Policy.admin(st);
  document.body.classList.toggle('not-admin', !adm);

  // 15業務タブの表示・非表示（許可されていないタブはUIから完全に隠す）
  document.querySelectorAll('nav button[data-page]').forEach(b => {
    const p = b.dataset.page;
    const ok = p === 'staff' ? adm : Policy.hasTab(st, p);
    b.style.display = ok ? '' : 'none';
  });

  // ページコンテナへのアクセス制限
  document.querySelectorAll('.page').forEach(sec => {
    const p = sec.id;
    const ok = p === 'staff' ? adm : Policy.hasTab(st, p);
    sec.classList.toggle('forbidden', !ok);
  });

  // 現在のタブが非許可なら最初の許可タブへ自動遷移
  const act = document.querySelector('nav button.active');
  if(!act || act.style.display === 'none'){
    const first = [...document.querySelectorAll('nav button[data-page]')].find(b => b.style.display !== 'none');
    if(first) first.click();
  }

  // 画面ヘッダーのユーザー情報
  let ub = document.querySelector('.user-box');
  if(!ub){
    ub = document.createElement('div');
    ub.className = 'user-box';
    const hdr = document.querySelector('header');
    if(hdr) hdr.appendChild(ub);
  }
  if(ub){
    ub.innerHTML = `<span>${esc(st.name || st.staffId)}（${adm ? '管理者' : '一般社員'}）</span><button id="ubPw" type="button">パスワード変更</button><button id="ubOut" type="button">ログアウト</button>`;
    const outBtn = document.getElementById('ubOut'); if(outBtn) outBtn.onclick = () => Sync.logout();
    const pwBtn = document.getElementById('ubPw'); if(pwBtn) pwBtn.onclick = () => {
      document.body.classList.add('locked');
      document.getElementById('authForm').style.display = 'none';
      document.getElementById('authPwForm').style.display = '';
      document.getElementById('authPwHint').textContent = '新しいパスワード（10文字以上）を入力してください。';
      S.changingPw = true;
    };
  }
}

async function enter(){
  const ov = document.getElementById('authOverlay');
  const authForm = document.getElementById('authForm');
  const authPwForm = document.getElementById('authPwForm');
  if(authForm) authForm.style.display = 'none';
  if(S.staff && S.staff.mustChangePassword){
    if(ov) ov.style.display = 'flex';
    document.body.classList.add('locked');
    if(authPwForm) authPwForm.style.display = '';
    const hint = document.getElementById('authPwHint');
    if(hint) hint.textContent = '新しいパスワード（10文字以上）を設定してください。';
    return;
  }
  if(authPwForm) authPwForm.style.display = 'none';
  if(ov) ov.style.display = 'none';
  document.body.classList.remove('locked');
  applyPerms();
  toast('ログインしました（' + esc(S.staff.name || S.staff.staffId) + '）');

  if(!S.started){
    S.started = true;
    startLists();
    switchTab(S.activeTab);
    if(S.enableAudit){
      try {
        await S.store.runTx(async tx => {
          tx.set('auditLogs', `login__${S.uid}__${Date.now()}`, { at: TS, by: S.uid, byId: S.staff.staffId, col: 'auth', docId: S.uid, op: 'login', version: 0, fields: [] });
        });
      } catch(e){}
    }
  } else {
    switchTab(S.activeTab);
  }
}

/* ====================================================================
   社員管理画面（管理者専用・タブ別チェックボックス設定）
   ==================================================================== */
let STAFF_CACHE = [];

window.onStaffRoleChange = function(uid, newRole){
  const isAdmin = newRole === 'admin';
  const grid = document.getElementById('tabGrid_' + uid);
  const notice = document.getElementById('adminTabNotice_' + uid);
  if(grid){
    grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if(isAdmin){ cb.checked = true; cb.disabled = true; }
      else { cb.disabled = false; }
    });
  }
  if(notice) notice.style.display = isAdmin ? 'block' : 'none';
};

function renderStaffAdmin(docs){
  if(docs) STAFF_CACHE = docs;
  const box = document.getElementById('staffBody');
  if(!box || !Policy.admin(S.staff)) return;
  const rows = STAFF_CACHE.slice().sort((a, b) => String(a.data.staffId).localeCompare(String(b.data.staffId)));
  const adminsActive = rows.filter(r => r.data.role === 'admin' && r.data.active).length;

  box.innerHTML = `<div class="panel"><h2>社員情報の登録（Firebaseコンソール作成後の紐付け）</h2>
   <p class="help">
     ※ 本システムはFirebase無料プラン運用の安全のため、ユーザーアカウントはFirebaseコンソールのAuthentication画面で作成します。<br>
     作成されたユーザーの「UID」をコピーし、ここで社員情報と権限を紐付けて登録してください。
   </p>
   <div class="row">
     <div class="field"><label>Firebase UID（AuthenticationのユーザーUID）</label><input id="stfUid" autocomplete="off" placeholder="例: aB3dE... (Firebaseコンソールからコピー)"></div>
     <div class="field"><label>社員ID（半角英数字）</label><input id="stfId" autocomplete="off" placeholder="例: suzuki"></div>
     <div class="field"><label>表示名（氏名）</label><input id="stfName" placeholder="例: 鈴木 健一"></div>
   </div>
   <div class="row">
     <div class="field"><label>権限ロール</label><select id="stfRole"><option value="staff" selected>一般社員（許可タブのみ利用）</option><option value="admin">管理者（全機能・全タブ・社員管理）</option></select></div>
   </div>
   <button class="btn" type="button" id="stfAdd">社員情報を登録</button>
   <div class="help" id="stfMsg" style="margin-top:6px"></div>
  </div>
  <div class="panel"><h2>登録済み社員一覧とタブ別権限設定（${rows.length}人 / 有効な管理者 ${adminsActive}人）</h2>
    ${rows.map(r => staffRow(r, adminsActive)).join('') || '<div class="empty">登録されている社員がいません</div>'}
  </div>`;

  document.getElementById('stfAdd').onclick = addStaffRecord;
  box.querySelectorAll('[data-save]').forEach(b => b.onclick = () => saveStaff(b.dataset.save));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteStaff(b.dataset.del));
}

function staffRow(r, adminsActive){
  const d = r.data, self = r.id === S.uid;
  const isAdmin = d.role === 'admin';
  const allowed = d.allowedTabs || [];

  const tabsHtml = ALL_BUSINESS_TABS.map(t => {
    const checked = isAdmin || allowed.includes(t.id);
    const disabled = isAdmin ? 'disabled' : '';
    return `<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:${checked ? '#f0fdf4' : '#f8fafc'};border:1px solid ${checked ? '#bbf7d0' : '#e2e8f0'};border-radius:6px;cursor:${isAdmin ? 'default' : 'pointer'};font-size:12px">
      <input type="checkbox" name="tab_${esc(r.id)}" value="${esc(t.id)}" ${checked ? 'checked' : ''} ${disabled}>
      <span style="font-weight:${checked ? '700' : '400'};color:${checked ? '#166534' : '#475569'}">${esc(t.label)}</span>
      <code style="font-size:10px;color:#94a3b8;margin-left:auto">${esc(t.id)}</code>
    </label>`;
  }).join('');

  return `<div class="staff-row ${d.active ? '' : 'off'}" data-uid="${esc(r.id)}" style="background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05)">
    <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:10px">
      <div>
        <b style="font-size:15px;color:#0f172a">${esc(d.staffId)}</b>　<span style="font-size:14px;color:#334155">${esc(d.name || '')}</span>
        <span style="margin-left:8px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${isAdmin ? '#eff6ff' : '#f1f5f9'};color:${isAdmin ? '#1d4ed8' : '#475569'};border:1px solid ${isAdmin ? '#bfdbfe' : '#cbd5e1'}">
          ${isAdmin ? '管理者' : '一般社員'}
        </span>
        <code style="font-size:11px;color:#94a3b8;margin-left:6px">UID: ${esc(r.id)}</code>
      </div>
      <span style="font-size:12px;color:${d.active ? '#059669' : '#dc2626'};font-weight:700">${d.active ? '有効' : '無効（利用停止）'}${self ? '（ログイン中）' : ''}</span>
    </div>
    ${self ? `<div class="help" style="color:#64748b">※ ログイン中の自分自身のアカウント権限は変更できません。</div>` : `
      <div class="row" style="margin-top:6px;gap:12px">
        <div class="field" style="flex:1"><label>権限ロール</label>
          <select data-f="role" onchange="window.onStaffRoleChange('${esc(r.id)}', this.value)">
            <option value="staff" ${!isAdmin ? 'selected' : ''}>一般社員（許可タブのみ利用）</option>
            <option value="admin" ${isAdmin ? 'selected' : ''}>管理者（全機能・全タブ・社員管理）</option>
          </select>
        </div>
        <div class="field" style="flex:1"><label>アカウント状態</label>
          <select data-f="active">
            <option value="1" ${d.active ? 'selected' : ''}>有効</option>
            <option value="0" ${d.active ? '' : 'selected'}>無効（ログインしてもアクセス遮断）</option>
          </select>
        </div>
      </div>
      <div style="margin:10px 0 6px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <label style="font-size:12px;font-weight:700;color:#334155">タブ別利用許可（閲覧・編集）：</label>
          <span style="font-size:11px;color:#64748b">チェックあり＝閲覧・編集可能 ／ チェックなし＝アクセス不可（非表示）</span>
        </div>
        <div id="tabGrid_${esc(r.id)}" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(170px, 1fr));gap:6px">
          ${tabsHtml}
        </div>
        <div id="adminTabNotice_${esc(r.id)}" style="${isAdmin ? 'display:block' : 'display:none'};margin-top:4px;font-size:11px;color:#2563eb;font-weight:600">
          ※ 管理者はすべてのタブと機能が自動的に許可されます。
        </div>
      </div>
      <div style="margin:8px 0;padding:8px 10px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:6px">
        <label class="inline-check" style="display:inline-flex;gap:6px;align-items:center;font-size:12px;color:#334155">
          <input type="checkbox" data-f="deleteList" ${d.actions && d.actions.deleteList ? 'checked' : ''}>
          <span><b>リストの削除を許可</b>（「リスト登録」タブが許可されている場合のみ有効）</span>
        </label>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <button class="btn small" type="button" data-save="${esc(r.id)}">権限設定を保存</button>
        <button class="btn small" type="button" data-del="${esc(r.id)}" style="background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;cursor:pointer">🗑️ 社員を削除</button>
      </div>
    `}
  </div>`;
}

async function addStaffRecord(){
  const uid = document.getElementById('stfUid').value.trim();
  const id = document.getElementById('stfId').value.trim().toLowerCase();
  const name = document.getElementById('stfName').value.trim();
  const role = document.getElementById('stfRole').value;
  const m = document.getElementById('stfMsg');

  if(!uid){ m.textContent = 'Firebase UIDを入力してください'; return; }
  if(!id){ m.textContent = '社員IDを入力してください'; return; }
  if(!name){ m.textContent = '表示名を入力してください'; return; }

  try {
    const initialTabs = role === 'admin' ? TAB_IDS : [];
    await S.store.runTx(async tx => {
      tx.set('staff', uid, {
        staffId: id,
        name,
        role,
        active: true,
        allowedTabs: initialTabs,
        actions: { deleteList: role === 'admin' },
        mustChangePassword: false,
        version: 1,
        createdAt: TS,
        createdBy: S.uid,
        updatedAt: TS,
        updatedBy: S.uid
      });
      if(S.enableAudit){
        tx.set('auditLogs', logId('staff', uid, 1), auditDoc('staff', uid, 1, 'create', [], {}));
      }
    });
    m.textContent = `「${name}」(${id}) を登録しました。下の一覧で利用許可タブを設定してください。`;
    ['stfUid', 'stfId', 'stfName'].forEach(i => document.getElementById(i).value = '');
  } catch(e) {
    m.textContent = '登録に失敗しました：' + (e.message || e);
  }
}

async function saveStaff(uid){
  const row = document.querySelector(`.staff-row[data-uid="${CSS.escape(uid)}"]`);
  const cur = STAFF_CACHE.find(x => x.id === uid);
  if(!row || !cur || uid === S.uid) return;

  const role = row.querySelector('[data-f=role]').value;
  const active = row.querySelector('[data-f=active]').value === '1';
  const del = row.querySelector('[data-f=deleteList]').checked;

  let allowedTabs = [];
  if(role === 'admin'){
    allowedTabs = TAB_IDS.slice();
  } else {
    row.querySelectorAll(`input[name="tab_${CSS.escape(uid)}"]:checked`).forEach(cb => {
      allowedTabs.push(cb.value);
    });
  }

  const wasAdminActive = cur.data.role === 'admin' && cur.data.active;
  const willAdminActive = role === 'admin' && active;
  if(wasAdminActive && !willAdminActive && STAFF_CACHE.filter(x => x.data.role === 'admin' && x.data.active).length <= 1){
    alert('有効な管理者が0人になってしまうため変更できません。');
    return;
  }

  const next = { role, active, allowedTabs, actions: { deleteList: del } };
  const ops = diff({
    role: cur.data.role,
    active: cur.data.active,
    allowedTabs: cur.data.allowedTabs || [],
    actions: cur.data.actions || {}
  }, next);

  if(!ops.length){ toast('変更はありません'); return; }
  try {
    await S.store.runTx(async tx => {
      const c = await tx.get('staff', uid);
      const nv = (c.version || 0) + 1;
      tx.update('staff', uid, [
        ...ops,
        { p: ['version'], v: nv },
        { p: ['updatedAt'], v: TS },
        { p: ['updatedBy'], v: S.uid }
      ]);
      if(S.enableAudit){
        tx.set('auditLogs', logId('staff', uid, nv), auditDoc('staff', uid, nv, 'permission', ops, c));
      }
    });
    toast('社員の権限設定を保存しました');
  } catch(e) {
    toast('保存できませんでした：' + (e.message || e), 'err');
  }
}

async function deleteStaff(uid){
  if(uid === S.uid){
    alert('ログイン中の自分自身のアカウントは削除できません。');
    return;
  }
  const cur = STAFF_CACHE.find(x => x.id === uid);
  const name = cur ? `${cur.data.name || ''}（ID: ${cur.data.staffId || ''}）` : uid;

  const wasAdminActive = cur && cur.data.role === 'admin' && cur.data.active;
  if(wasAdminActive && STAFF_CACHE.filter(x => x.data.role === 'admin' && x.data.active).length <= 1){
    alert('有効な管理者が0人になってしまうため削除できません。');
    return;
  }

  if(!confirm(`社員「${name}」を削除しますか？\n\n【注意】\n削除すると、この社員情報は一覧から消去され、システムにログインできなくなります。`)){
    return;
  }

  try {
    await S.store.runTx(async tx => {
      tx.delete('staff', uid);
      if(S.enableAudit){
        tx.set('auditLogs', logId('staff', uid, Date.now()), {
          at: TS, by: S.uid, byId: (S.staff && S.staff.staffId) || S.uid, col: 'staff', docId: uid, op: 'delete', version: 0, fields: []
        });
      }
    });
    toast(`社員「${name}」の登録情報を削除しました`);
  } catch(e) {
    toast('削除できませんでした：' + (e.message || e), 'err');
  }
}

/* ====================================================================
   操作履歴（auditLogs）管理：30日経過分の手動一括削除
   ==================================================================== */
async function purgeOldAuditLogs(){
  if(!Policy.admin(S.staff)) throw new Error('管理者のみ実行できます');
  const d = new Date(); d.setDate(d.getDate() - 30);
  const cutoff = d.toISOString();
  toast('30日以上前の操作履歴を検索中...');
  const logs = await S.store.colGet('auditLogs', { field: 'at', op: '<=', value: cutoff });
  if(!logs.length){
    alert('30日以上経過した操作履歴はありません。');
    return 0;
  }
  if(!confirm(`30日以上経過した操作履歴が ${logs.length} 件見つかりました。\nこれらを一括削除しますか？`)){
    return 0;
  }
  let deleted = 0;
  for(let i = 0; i < logs.length; i += 50){
    const chunk = logs.slice(i, i + 50);
    await S.store.runTx(async tx => {
      chunk.forEach(l => tx.delete('auditLogs', l.id));
    });
    deleted += chunk.length;
  }
  toast(`${deleted} 件の古い操作履歴を削除しました`);
  return deleted;
}

/* ====================================================================
   完了案件の削除（90日経過後・管理者専用・事前バックアップ対応）
   ==================================================================== */
async function purgeCompletedLists(serials){
  if(!Policy.admin(S.staff)) throw new Error('管理者のみ実行できます');
  if(!serials || !serials.length) return 0;
  let count = 0;
  for(let i = 0; i < serials.length; i += 10){
    const chunk = serials.slice(i, i + 10);
    await S.store.runTx(async tx => {
      for(const id of chunk){
        tx.delete('lists', id);
        count++;
      }
    });
  }
  // 画面・キャッシュ同期
  const sSet = new Set(serials.map(String));
  serials.forEach(id => { S.base.lists.delete(id); S.raw.delete(id); });
  const newLists = S.B.getLists().filter(l => !sSet.has(String(l.serial)));
  S.B.setLists(newLists);
  S.B.renderSoon();
  toast(`${count} 件の完了案件を削除しました`);
  return count;
}

/* ====================================================================
   手動バックアップ／復元（管理者のみ・週1回手動運用）
   ==================================================================== */
async function exportAll(){
  if(!Policy.admin(S.staff)) throw new Error('管理者のみ実行できます');
  const st = S.store;
  toast('全データを読み出し中...');
  const lists = (await st.colGet('lists', null)).filter(d => !d.data.deleted);
  const evs = (await st.colGet('events', null)).filter(d => !d.data.deleted);
  const boards = await st.colGet('boards', null);
  const settings = await st.docGet('settings', 'cutSpeeds');
  const counter = await st.docGet('counters', 'serial');
  const staffDocs = await st.colGet('staff', null);
  let auditDocs = [];
  try { auditDocs = (await st.colGet('auditLogs', null)).slice(-200); } catch(e){}

  const meta = {}, deliveryEvents = [];
  const outLists = lists.map(d => {
    const l = docToList(stripServer(d.data));
    if(d.data.deliveryInfo) meta['L:'+d.id] = { slip: d.data.deliveryInfo.slip || '', sales: d.data.deliveryInfo.sales || '' };
    return l;
  });
  evs.forEach(d => {
    const e = stripEv(d.data);
    if(e.slip || e.sales) meta['E:'+d.id] = { slip: e.slip || '', sales: e.sales || '' };
    delete e.slip; delete e.sales;
    deliveryEvents.push(e);
  });
  const stageBoard = {}; let deliveryBoard = [];
  boards.forEach(({ data }) => {
    const arr = [];
    Object.entries(data.memos || {}).sort((a, b) => (a[1].pos || 0) - (b[1].pos || 0)).forEach(([id, m]) => arr.push(data.key === 'delivery' ? { key: id, memo: m.text } : { type: 'memo', id, text: m.text }));
    if(data.key === 'delivery') deliveryBoard = arr; else stageBoard[data.key] = arr;
  });

  const staffList = staffDocs.map(sd => ({
    uid: sd.id,
    staffId: sd.data.staffId,
    name: sd.data.name,
    role: sd.data.role,
    active: sd.data.active,
    allowedTabs: sd.data.allowedTabs || [],
    actions: sd.data.actions || {},
    version: sd.data.version || 1,
    createdAt: sd.data.createdAt,
    updatedAt: sd.data.updatedAt
  }));

  return {
    format: 'production-backup-v2',
    source: 'firestore-production',
    projectId: CFG.firebase.projectId,
    exportedAt: new Date().toISOString(),
    lists: outLists,
    deliveryBoard,
    deliveryEvents,
    deliveryMeta: meta,
    stageBoard,
    cutSpeeds: settings ? settings.items : [],
    serialCounter: counter ? counter.last : 0,
    staff: staffList,
    auditLogs: auditDocs.map(a => a.data)
  };
}

async function restore(data){
  if(!Policy.admin(S.staff)) throw new Error('管理者のみ実行できます');
  if(!data || typeof data !== 'object') throw new Error('復元データの形式が正しくありません');

  const all = Array.isArray(data) ? data : (data.lists || []);
  const evs = data.deliveryEvents || [];
  const meta = data.deliveryMeta || {};
  const staff = data.staff || [];
  const cutSpeeds = data.cutSpeeds || [];

  // 事前に復元対象と件数を表示
  const preview = `【復元対象の確認】
- 案件数: ${all.length} 件
- 配送イベント: ${evs.length} 件
- 設定（切断速度）: ${cutSpeeds.length} 件
- 社員権限情報: ${staff.length} 名

※ 復元を実行すると、現在のデータがバックアップ内容で上書きされます。
本当に復元を実行しますか？`;

  if(!confirm(preview)) return 0;

  const st = S.store;
  let restoredLists = 0;

  try {
    for(let i = 0; i < all.length; i += 4){
      const chunk = all.slice(i, i + 4);
      await st.runTx(async tx => {
        const pre = []; for(const l of chunk) pre.push(await tx.get('lists', String(l.serial)));
        chunk.forEach((l, k) => {
          const id = String(l.serial);
          const doc = listToDoc(l);
          const info = meta['L:'+id];
          if(info) doc.deliveryInfo = { slip: info.slip || '', sales: info.sales || '' };
          const nv = (pre[k] && pre[k].version || 0) + 1;
          tx.set('lists', id, { ...doc, deleted: false, version: nv, createdBy: (pre[k] && pre[k].createdBy) || S.uid, updatedAt: TS, updatedBy: S.uid });
          restoredLists++;
        });
      });
    }

    for(const e of evs){
      await st.runTx(async tx => {
        const id = String(e.id);
        const pre = await tx.get('events', id);
        const m = meta['E:'+id] || {};
        const nv = (pre && pre.version || 0) + 1;
        tx.set('events', id, { ...e, slip: m.slip || '', sales: m.sales || '', date: e.date || '', deleted: false, version: nv, createdBy: S.uid, updatedAt: TS, updatedBy: S.uid });
      });
    }

    if(Array.isArray(cutSpeeds) && cutSpeeds.length){
      await st.runTx(async tx => {
        const pre = await tx.get('settings', 'cutSpeeds');
        const nv = (pre && pre.version || 0) + 1;
        tx.set('settings', 'cutSpeeds', { items: cutSpeeds, deleted: false, version: nv, createdBy: S.uid, updatedAt: TS, updatedBy: S.uid });
      });
    }

    const mx = all.reduce((a, l) => { const m = /^S(\d{5})$/.exec(String(l.serial)); return m ? Math.max(a, +m[1]) : a; }, 0);
    if(mx){
      await st.runTx(async tx => {
        const c = await tx.get('counters', 'serial');
        if(!c) tx.set('counters', 'serial', { last: mx });
        else if(c.last < mx) tx.update('counters', 'serial', [{ p: ['last'], v: mx }]);
      });
    }

    if(Array.isArray(staff)){
      for(const stf of staff){
        if(stf.uid === S.uid) continue; // ログイン中本人は保護
        try {
          await st.runTx(async tx => {
            const pre = await tx.get('staff', stf.uid);
            const nv = (pre && pre.version || 0) + 1;
            tx.set('staff', stf.uid, {
              staffId: stf.staffId,
              name: stf.name,
              role: stf.role,
              active: stf.active,
              allowedTabs: stf.allowedTabs || [],
              actions: stf.actions || {},
              mustChangePassword: false,
              version: nv,
              createdAt: stf.createdAt || new Date().toISOString(),
              createdBy: S.uid,
              updatedAt: TS,
              updatedBy: S.uid
            });
          });
        } catch(e){}
      }
    }

    resync();
    alert(`復元が正常に完了しました（案件 ${restoredLists}件、配送イベント ${evs.length}件）。\n画面を最新状態に再同期しました。`);
    return restoredLists;
  } catch(err) {
    console.error('復元エラー:', err);
    alert('復元中にエラーが発生しました。正常終了として扱えません：' + (err && err.message || err));
    throw err;
  }
}

/* ====================================================================
   起動と認証リスナー
   ==================================================================== */
function initAuthListener(){
  if(!S.store || !S.store.auth) return;
  S.store.auth.onChange(async u => {
    if(S.staffUnsub){ try{ S.staffUnsub(); }catch(e){} S.staffUnsub = null; }
    if(!u){ S.uid = null; S.staff = null; showLogin(); return; }
    S.uid = u.uid; let first = true;
    S.staffUnsub = S.store.docWatch('staff', u.uid, async d => {
      if(!d){
        await S.store.auth.signOut();
        showLogin('社員情報が登録されていません。管理者に連絡してください。');
        return;
      }
      if(!d.active){
        await S.store.auth.signOut();
        showLogin('このアカウントは無効化されています。管理者に連絡してください。');
        return;
      }
      const prev = S.staff; S.staff = d;
      if(first){ first = false; enter(); }
      else if(prev && (!eq(prev.allowedTabs, d.allowedTabs) || prev.role !== d.role || !eq(prev.actions, d.actions))){
        applyPerms();
        switchTab(S.activeTab);
        toast('あなたの利用権限が更新されました');
      }
    }, async e => {
      console.error(e);
      await S.store.auth.signOut();
      showLogin('社員情報の取得に失敗しました：' + (e.message || e));
    });
  });
}

const Sync = {
  on: true,
  mode: 'firestore',
  Policy, diff, applyOps,
  async boot(bridge){
    S.B = bridge; ui(); document.body.classList.add('locked');

    if(!HAS_FS || CFG.mode !== 'firestore'){
      showConnectionError('public/firebase-config.js の設定が無効です。本番設定を確認してください。');
      return;
    }

    try {
      S.store = await makeFirestore();
    } catch(e) {
      console.error('Firebase initialization failed:', e);
      showConnectionError(e);
      return;
    }

    initAuthListener();
  },
  pushLists, pushDelivery, pushStage, pushSettings, nextSerial,
  exportAll, restore,
  switchTab,
  purgeCompletedLists,
  purgeOldAuditLogs,
  setAuditEnabled(en){ S.enableAudit = !!en; },
  isAuditEnabled(){ return S.enableAudit; },
  async logout(){
    stopData();
    if(S.store && S.store.auth) await S.store.auth.signOut();
  },
  isAdmin: () => Policy.admin(S.staff),
  staff: () => S.staff,
  _state: S
};

window.Sync = Sync;
})();
