/* ================= 状態 ================= */
/* 版の表示はここ1か所から。ヘッダー・使い方・保存状態・PWA名すべてこれを使う */
const APP_NAME    = '境界復元';
const APP_EDITION = '地図版';
const APP_VERSION = 'v0.10';
const APP_BUILD   = '@@BUILD@@';          // ビルド時に日付と版ハッシュが入る
function appTitle(){ return `${APP_NAME} ${APP_EDITION} ${APP_VERSION}`; }
function appFull(){  return `境界復元支援アプリ（${APP_EDITION}）${APP_VERSION}`; }

const DEFAULT_SETTINGS = {
  zone:1, mockGps:false, colorMode:'auto', mockDate:null, worker:'',
  stake:'コンクリート杭', stakes:null, stakesVer:4,
  baseMap:'std', lastView:null, tiffAlpha:1, fontScale:'m',
  lastExport:null, setVer:1,
  thinPt:300,      // 画面内の点がこれを超えたら「線と点」だけにする（点名・マークを出さない）
  thinName:150,    // 画面内の点がこれ以下なら点名も出す
  thinDist:40      // 画面上でこのpx以上に見えている辺にだけ距離を出す
};
const store = {
  appId:    'kyokai-fukugen-map-v1', // 選点地図版の保存データと取り違えないための識別子
  imports:  [],   // 取り込んだファイル {id, name, src:'sima'|'csv', kind:'bp'|'ref', ts}
  points:   [],   // 境界点（復元の対象） {id, impId, no, name, x(東), y(北), z, idx, rec?}
  refPoints:[],   // 基準点（参考・記録の対象外） {id, impId, no, name, x, y, z}
  lines:    [],   // 画地の線 {id, impId, no, name, ptIds:[], dists:[], closed}
  routes:   [],   // 計測線（自分で引いた線） {id, ptIds:[], date, ts}
  strokes:  [],   // 手書きメモ {color, w(map単位), pts:[[x,y],...]}
  settings: Object.assign({}, DEFAULT_SETTINGS),
  disp: {},
  layers: { pt:true, ref:true, line:true, plotName:true, route:true, dist:true, memo:true,
            base:true, map:true, hiddenImports:[], hiddenPlotNames:[],
            stNone:true, stDa:true, stKi:true }
};
const state = {
  mode:'view', follow:true,
  view:{ cx:0, cy:0, scale:1 },   // 地図座標(東=x,北=y), scale=px/地図単位
  tiff:null, tiffInfo:'', detail:null,
  epsg:null, geographic:false,
  gps:{ ok:false, lat:0, lon:0, acc:0, x:0, y:0 },
  tiffs: [],
  currentRoute:[],                // 計測中に選んでいる点
  memoColor:'#d9261c', eraser:false,
  fixing:null,                    // 使わない（共通部品との互換のため残す）
  saveError:false,
  drawInfo:{ n:0, mode:'dot' }    // 直前の描画で点をどう出したか（画面の案内に使う）
};
const APP_STORAGE_ID = 'kyokai-fukugen-map-v1';
const LS_KEY = 'kyokaiFukugenMapData_v1';
const LEGACY_LS_KEY = 'fukugenAppData_v1';
/* 指先はマウスポインタより接触面が広く、わずかにずれやすい。
   タッチ端末では選点の当たり判定だけを広げ、密集点では最も近い点を選ぶ。 */
const TOUCH_HIT_RADIUS = (navigator.maxTouchPoints>0 ||
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) ? 44 : 32;

/* ================= 杭種 =================
   点名そのものは変えず、打設・既設の表示時だけ杭種の略称を末尾に付ける。 */
const STAKES_VERSION = 4;
const DEFAULT_STAKES = ['コンクリート杭','プラスチック杭','金属鋲','金属標','アルミプレート','ペンキ'];
const STAKE_ABBR = Object.freeze({
  'プラスチック杭':'P', '金属鋲':'B', '金属標':'K',
  'アルミプレート':'L', 'ペンキ':'M', 'コンクリート杭':'C'
});
function normalizeStakeName(name){
  const s=String(name||'').trim();
  return s==='金属プレート' ? 'アルミプレート' : s==='マーキング' ? 'ペンキ' : s;
}
function stakeAbbr(name){ return STAKE_ABBR[normalizeStakeName(name)] || ''; }
function stakeList(){
  const s = store.settings.stakes;
  /* 選点地図版の杭種はオブジェクト配列。保存先が衝突していた旧版でそれを
     読むと「[object Object]」と表示されたため、文字列以外は既定値へ戻す。 */
  const valid = Array.isArray(s) && s.length
    && s.every(v=>typeof v==='string' && v.trim());
  if(!valid || ![2,3,STAKES_VERSION].includes(store.settings.stakesVer)){
    store.settings.stakes = DEFAULT_STAKES.slice();
    store.settings.stakesVer = STAKES_VERSION;
    store.settings.stake = DEFAULT_STAKES[0];
  }else{
    store.settings.stakes = [...new Set(s.map(normalizeStakeName).filter(Boolean))];
    /* 旧版の一覧や利用者が追加した杭種は保ち、新しい「ペンキ」だけを一度追加する。 */
    if(store.settings.stakesVer<STAKES_VERSION && !store.settings.stakes.includes('ペンキ')){
      store.settings.stakes.push('ペンキ');
    }
    store.settings.stakesVer = STAKES_VERSION;
    store.settings.stake = normalizeStakeName(store.settings.stake);
  }
  return store.settings.stakes;
}
function currentStake(){
  const l = stakeList();
  return l.includes(store.settings.stake) ? store.settings.stake : l[0];
}
function setStake(name){
  store.settings.stake = name;
  save(); updateActionbar();
  toast(`杭種: ${name}`);
}

/* ================= 日付 ================= */
function realTodayStr(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayStr(){
  const m=store.settings.mockDate;
  return (m && /^\d{4}-\d{2}-\d{2}$/.test(m)) ? m : realTodayStr();
}
function dateLabel(ds){
  if(!ds) return '日付なし';
  const [y,m,d]=ds.split('-');
  return `${+m}/${+d}`+(ds===todayStr()?'（本日）':'');
}

/* ================= 画面の表示設定 ================= */
const DEFAULT_DISP = {
  stDaColor:'#d9261c',    // 打設
  stKiColor:'#1e73d2',    // 既設
  stNoColor:'#8a8f96',    // 未
  ptMarkSize:'m', ptNameSize:'m',
  lineColor:'#5a3ea8', lineWidth:2,          // 画地の線
  plotNameColor:'#3d2680', plotNameSize:'l', // 画地名（地番）の文字
  routeColor:'#e07800', routeWidth:3,        // 計測線
  distColor:'#1b3a1b', distSize:'m',         // 距離の文字
  refColor:'#39FF14', refMarkSize:'m', refNameSize:'m'
};
const SIZE_STEPS = { s:0.75, m:1, l:1.3, xl:1.6 };
const SIZE_NAMES = { s:'小', m:'中', l:'大', xl:'特大' };
function disp(k){
  const v = store.disp ? store.disp[k] : undefined;
  return (v===undefined || v===null || v==='') ? DEFAULT_DISP[k] : v;
}
function sizeMul(k){ return SIZE_STEPS[disp(k)] || 1; }
function labelFont(k){ return Math.round(12 * sizeMul(k)); }

/* ================= 復元の記録（打設 / 既設） =================
   打設 … 現地に杭が無く、復元して新しく打った点
   既設 … 現地に杭があった点
   未   … まだ現地を見ていない点
   点ごとに p.rec = {k:'da'|'ki', d:記録日, w:記録者, s:杭種, t:記録時刻} を持つ。
   記録は画面の中だけの情報で、取り込んだ座標には手を触れない。 */
const REC_UNDO_MAX = 50;
const recUndo = [], recRedo = [];
const ST_NAME = { da:'打設', ki:'既設', no:'未' };
function stOf(p){ const r=p&&p.rec; return (r&&(r.k==='da'||r.k==='ki')) ? r.k : 'no'; }
function stColor(k){ return k==='da'?disp('stDaColor') : k==='ki'?disp('stKiColor') : disp('stNoColor'); }
function recDate(p){ return (p&&p.rec&&p.rec.d)||''; }
function recWorker(p){ return (p&&p.rec&&p.rec.w)||''; }
function recStake(p){ return normalizeStakeName((p&&p.rec&&p.rec.s)||''); }
function displayPointName(p){
  const name=String((p&&p.name)||'');
  const abbr=stOf(p)==='no' ? '' : stakeAbbr(recStake(p));
  return name+abbr;
}
function progCounts(){
  let da=0, ki=0, no=0;
  for(const p of store.points){ const k=stOf(p); if(k==='da') da++; else if(k==='ki') ki++; else no++; }
  return { da, ki, no, done:da+ki, all:store.points.length };
}
/* 記録を書き換える（取消・やり直しの1手として積む） */
function applyRec(p, rec, quiet){
  if(!p) return false;
  const before = p.rec ? Object.assign({}, p.rec) : null;
  if(rec) p.rec = rec; else delete p.rec;
  recUndo.push({ id:p.id, before, after: rec ? Object.assign({}, rec) : null });
  if(recUndo.length>REC_UNDO_MAX) recUndo.shift();
  recRedo.length = 0;
  save(); draw(); updateActionbar(); updateProg(); refreshEdits();
  return true;
}
function setRec(id, kind, stake){
  const p = ptById(id);
  if(!p) return;
  if(kind!=='da' && kind!=='ki') return;
  applyRec(p, { k:kind, d:todayStr(), w:(store.settings.worker||'').trim(),
                s:normalizeStakeName(stake||currentStake()), t:Date.now() });
  const c = progCounts();
  toast(`${displayPointName(p)} を ${ST_NAME[kind]} にしました（打設${c.da}／既設${c.ki}）`);
}
function clearRec(id){
  const p = ptById(id);
  if(!p || stOf(p)==='no') return;
  applyRec(p, null);
  toast(`${p.name} の記録を取り消しました`);
}
function moveRec(rec, undoing){
  const p = ptById(rec.id);
  if(!p) return false;
  const v = undoing ? rec.before : rec.after;
  if(v) p.rec = Object.assign({}, v); else delete p.rec;
  return true;
}
function undoRec(){
  const rec = recUndo.pop();
  if(!rec){ toast('取り消せる記録の操作はありません'); return; }
  if(!moveRec(rec, true)){ toast('対象の点が見つかりません'); return; }
  recRedo.push(rec);
  if(recRedo.length>REC_UNDO_MAX) recRedo.shift();
  save(); draw(); updateActionbar(); updateProg(); refreshEdits();
  toast('記録の操作を取り消しました');
}
function redoRec(){
  const rec = recRedo.pop();
  if(!rec){ toast('やり直せる記録の操作はありません'); return; }
  if(!moveRec(rec, false)){ toast('対象の点が見つかりません'); return; }
  recUndo.push(rec);
  if(recUndo.length>REC_UNDO_MAX) recUndo.shift();
  save(); draw(); updateActionbar(); updateProg(); refreshEdits();
  toast('記録の操作をやり直しました');
}

/* ================= 取り込んだデータ =================
   境界点(store.points) … 復元の対象。打設・既設を記録する
   基準点(store.refPoints) … 参考。蛍光緑で出すだけで記録はできない
   画地の線(store.lines) … SIMAの画地データ(D00〜D99)。線としてだけ描く
   点は「取り込んだファイル(imports)」ごとに表示/非表示を切り替えられる。 */
const REF_FILL='#39FF14', REF_STROKE='#0b5d1e', REF_LABEL='#0b5d1e';
let ptMap = null;                        // id → 点（境界点＋基準点）
function invalidatePtMap(){ ptMap = null; }
function ptIndex(){
  if(ptMap) return ptMap;
  ptMap = new Map();
  for(const p of store.points) ptMap.set(p.id, p);
  for(const p of store.refPoints) ptMap.set(p.id, p);
  return ptMap;
}
function ptById(id){ return ptIndex().get(id); }
function importById(id){ return store.imports.find(i=>i.id===id); }
function isImportVisible(id){ return !(store.layers.hiddenImports||[]).includes(id); }
function pointsOf(id){ return store.points.filter(p=>p.impId===id); }
function refPointsOf(id){ return store.refPoints.filter(p=>p.impId===id); }
function linesOf(id){ return store.lines.filter(l=>l.impId===id); }
function isStateVisible(k){
  return k==='da' ? store.layers.stDa!==false
       : k==='ki' ? store.layers.stKi!==false
       :            store.layers.stNone!==false;
}
function isPointVisible(p){
  return store.layers.pt!==false && isImportVisible(p.impId) && isStateVisible(stOf(p));
}
function isRefVisible(p){ return store.layers.ref!==false && isImportVisible(p.impId); }
function isAnyPointVisible(p){ return p.ref ? isRefVisible(p) : isPointVisible(p); }
function isLineVisible(l){ return store.layers.line!==false && isImportVisible(l.impId); }
/* 地番名は「全体のスイッチ」と「取込ファイルごとのスイッチ」の両方が表示のときだけ出す */
function isPlotNameOn(){ return store.layers.plotName!==false; }
function isPlotNameVisible(l){
  return isPlotNameOn() && isImportVisible(l.impId)
      && !(store.layers.hiddenPlotNames||[]).includes(l.impId);
}
/* 画地（線）を持っている取込ファイルだけが、地番名の切り替えの対象になる */
function importsWithLines(){ return store.imports.filter(i=>linesOf(i.id).length>0); }
/* ---- 取込ファイルごとの色 ----
   imp.color を入れると、そのファイルの**画地の線と地番名**だけがその色になる。
   入れていなければ「表示設定」の種類別の色をそのまま使う。
   境界点そのものは打設（赤）・既設（青）・未（灰）の色を保つ。
   どこまで打ったかが色で分かることのほうが、ファイルの区別より現場では大事なため。 */
function isColorHex(c){ return typeof c==='string' && /^#[0-9a-fA-F]{6}$/.test(c); }
function impColor(id){
  const im = id && importById(id);
  return im && isColorHex(im.color) ? im.color : null;
}
function lineColorOf(l){     return impColor(l.impId) || disp('lineColor'); }
function plotNameColorOf(l){ return impColor(l.impId) || disp('plotNameColor'); }
/* 点がどの画地に属するか（一覧のまとめ方で使う。数が多いので都度作らず控える） */
let plotOfPt = null;
function invalidatePlotMap(){ plotOfPt = null; }
function plotIndex(){
  if(plotOfPt) return plotOfPt;
  plotOfPt = new Map();
  for(const l of store.lines){
    for(const id of l.ptIds) if(id && !plotOfPt.has(id)) plotOfPt.set(id, l.name || `画地${l.no}`);
  }
  return plotOfPt;
}
/* 画地の線のうち、両端の座標がそろっていて実際に引ける辺だけを数える。
   延長も、その辺の C03 の辺長だけを足す（欠けた頂点をまたぐ辺は数えない）。 */
function lineSegments(l, index){
  const idx = index || ptIndex();
  const ids = l.ptIds || [], m = ids.length;
  if(m<2) return { n:0, total:0 };
  const segs = l.closed ? m : m-1;
  let n=0, total=0;
  for(let i=0;i<segs;i++){
    const a=idx.get(ids[i]), b=idx.get(ids[(i+1)%m]);
    if(!a||!b) continue;
    n++;
    const d = (l.dists && isFinite(l.dists[i])) ? l.dists[i] : distBetween(a,b);
    total += d;
  }
  return { n, total };
}
function plotNameOf(p){ return plotIndex().get(p.id) || ''; }

/* ================= 座標系 ================= */
<!--@SRC:996-1185-->
/* X(北),Y(東) → 画面座標系(x=東, y=北)。経緯度表示中は投影して合わせる */
function xyToMapPoint(X,Y){
  if(state.geographic){
    try{ const ll=currentProj().inverse([Y,X]); return {x:ll[0], y:ll[1]}; }catch(e){ return {x:Y, y:X}; }
  }
  return {x:Y, y:X};
}
function pointToXY(p){   // 表示用 X=北, Y=東
  if(state.geographic){ const [e,n]=currentProj().forward([p.x,p.y]); return [n,e]; }
  return [p.y,p.x];
}
/* 2点間の距離（地図単位。経緯度表示中は平面直角に直してから測る） */
function distBetween(a,b){
  if(!a||!b) return 0;
  if(state.geographic){
    try{
      const pr=currentProj();
      const p1=pr.forward([a.x,a.y]), p2=pr.forward([b.x,b.y]);
      return Math.hypot(p1[0]-p2[0], p1[1]-p2[1]);
    }catch(e){}
  }
  return Math.hypot(a.x-b.x, a.y-b.y);
}
function fmtDist(d){ return (Math.round(d*1000)/1000).toFixed(3); }

/* ================= 永続化 ================= */
<!--@SRC:1192-1277-->
/* ================= 重ならないID =================
   流用元の newId() は「時刻＋乱数5文字」で、数千件を一度に作ると同じミリ秒の中で
   まれに衝突する（2,400点のSIMAを2回取り込むと数%の確率で1件重なった）。
   IDが重なると、画地の辺や記録が**別の点に付いてしまう**ので、
   通し番号を混ぜて必ず重ならないようにする。
   末尾の4文字は端末・起動ごとに変わるので、他の人の控えと合流しても衝突しない。 */
let idSeq = 0;
const ID_TAG = Math.random().toString(36).slice(2,6) + Math.random().toString(36).slice(2,6);
function newId(){ return Date.now().toString(36) + (idSeq++).toString(36) + ID_TAG; }

/* ================= 現場（プロジェクト）別の保存 =================
   端末の中に現場を並べて持ち、開けるのは1つだけ。切り替えると中身が丸ごと入れ替わる。
   IndexedDB(kv)の使い方
     'sites'      … 現場の目録 {list:[{id,name,created,updated,pts,done,lines}], active}
     'site:<id>'  … その現場の中身（点・画地・記録・レイヤ・表示設定・系番号…）
     'device'     … 端末で共通の設定（作業者名・杭種・文字サイズ・間引き・背景地図…）
     'store'      … v0.6までの1現場ぶん。起動時に「現場１」へ移して以降は読まない
   snapshots には siteId を付け、世代の整理は現場ごとに行う。 */
const SITES_KEY='sites', DEVICE_KEY='device', SITE_PREFIX='site:';
const SITE_MAX_DEFAULT=5, SITE_MAX_MIN=1, SITE_MAX_HI=10;
/* 端末に1つだけ持つ設定。現場を切り替えても変わらない */
const DEVICE_SETTING_KEYS=['worker','stakes','stakesVer','stake','fontScale',
  'thinPt','thinName','thinDist','baseMap','tiffAlpha','colorMode',
  'mockGps','mockDate','setVer','siteMax'];
function isDeviceKey(k){ return DEVICE_SETTING_KEYS.includes(k); }
let sites={ list:[], active:null };
function siteList(){ return sites.list||(sites.list=[]); }
function siteById(id){ return siteList().find(x=>x.id===id); }
function activeSite(){ return siteById(sites.active); }
function activeSiteName(){ const s=activeSite(); return s?s.name:''; }
function siteKey(id){ return SITE_PREFIX+id; }
function siteMax(){
  const n=parseInt(store.settings.siteMax,10);
  return (isFinite(n)&&n>=SITE_MAX_MIN&&n<=SITE_MAX_HI)?n:SITE_MAX_DEFAULT;
}
function siteFull(){ return siteList().length>=siteMax(); }
/* いまの現場の中身だけ。端末共通の設定は入れない */
function siteJson(){
  const st={};
  for(const k in store.settings) if(!isDeviceKey(k)) st[k]=store.settings[k];
  return JSON.stringify({
    appId:APP_STORAGE_ID, siteId:sites.active, siteName:activeSiteName(),
    points:store.points, refPoints:store.refPoints, lines:store.lines,
    routes:store.routes, strokes:store.strokes, imports:store.imports,
    disp:store.disp, layers:store.layers, settings:st
  });
}
function deviceJson(){
  const st={};
  for(const k of DEVICE_SETTING_KEYS) if(store.settings[k]!==undefined) st[k]=store.settings[k];
  return JSON.stringify({ appId:APP_STORAGE_ID, settings:st });
}
/* 控え・自動控え・合流が見るのは「いまの現場の中身」 */
function snapshotJson(){ return siteJson(); }
function siteMeta(){
  const c=progCounts();
  return { pts:c.all, done:c.done, lines:store.lines.length, updated:new Date().toISOString() };
}
function saveSites(){ return idbPut(DB_STORE, JSON.stringify(sites), SITES_KEY); }
async function flushSave(){
  if(!savePending) return;
  savePending=false;
  if(!sites.active) return;
  const json=siteJson();
  try{
    await idbPut(DB_STORE, json, siteKey(sites.active));
    await idbPut(DB_STORE, deviceJson(), DEVICE_KEY);
    const s=activeSite();
    if(s) Object.assign(s, siteMeta());
    await saveSites();
    clearSaveError();
    if(json!==lastSavedJson){ lastSavedJson=json;
      if(store.points.length||store.routes.length||store.strokes.length) pushSnapshot(json);
    }
  }catch(e){
    try{ localStorage.setItem(LS_KEY,json); clearSaveError(); }
    catch(e2){ markSaveError(e.message||e); }
  }
}
/* 待たずに今すぐ書く（現場を切り替える前に必ず通す） */
async function flushNow(){
  clearTimeout(saveTimer);
  savePending=true;
  await flushSave();
}
/* 自動控えは現場ごとに10世代（＋日付ごとの初回） */
async function pushSnapshot(json){
  if(snapBusy) return;
  snapBusy=true;
  try{
    const sid=sites.active||'';
    const now=new Date();
    const rec={ id:now.toISOString(), siteId:sid, date:realTodayStr(), json,
                pt:store.points.length, rt:store.routes.length, st:store.strokes.length };
    await idbPut('snapshots',rec);
    const all=(await idbReq('snapshots','readonly',s=>s.getAll()))
                .filter(r=>(r.siteId||'')===sid);
    all.sort((a,b)=>a.id<b.id?1:-1);
    const keepDates=new Set(), del=[];
    all.forEach((r,i)=>{
      const firstOfDay=!keepDates.has(r.date);
      keepDates.add(r.date);
      if(i>=SNAP_KEEP && !firstOfDay) del.push(r.id);
    });
    if(del.length) await idbReq('snapshots','readwrite',s=>{ del.forEach(id=>s.delete(id)); });
  }catch(e){}
  finally{ snapBusy=false; }
}
async function deleteSnapshotsOf(sid){
  try{
    const all=await idbReq('snapshots','readonly',s=>s.getAll());
    const del=all.filter(r=>(r.siteId||'')===sid).map(r=>r.id);
    if(del.length) await idbReq('snapshots','readwrite',s=>{ del.forEach(id=>s.delete(id)); });
  }catch(e){}
}
/* v0.6までの控えには現場が付いていないので、移行した現場のものとして扱う */
async function adoptOldSnapshots(sid){
  try{
    const all=await idbReq('snapshots','readonly',s=>s.getAll());
    const orphan=all.filter(r=>!r.siteId);
    if(!orphan.length) return;
    await idbReq('snapshots','readwrite',s=>{ orphan.forEach(r=>{ r.siteId=sid; s.put(r); }); });
  }catch(e){}
}
/* いまの現場の中身だけを空にする（端末共通の設定と他の現場は残す） */
function resetStoreData(){
  store.points=[]; store.refPoints=[]; store.lines=[];
  store.routes=[]; store.strokes=[]; store.imports=[];
  store.disp=Object.assign({}, DEFAULT_DISP);
  store.layers={ pt:true, ref:true, line:true, plotName:true, route:true, dist:true, memo:true,
                 base:true, map:true, hiddenImports:[], hiddenPlotNames:[],
                 stNone:true, stDa:true, stKi:true };
  store.settings.lastView=null;
  store.settings.lastExport=null;
  state.currentRoute=[];
  invalidatePtMap(); invalidatePlotMap();
}
/* 既定値の補完。読み込み・切替・新規のいずれからも通す */
function fillDefaults(){
  ['pt','ref','line','plotName','route','dist','memo','base','map','stNone','stDa','stKi'].forEach(k=>{
    if(store.layers[k]===undefined) store.layers[k]=true;
  });
  if(!Array.isArray(store.layers.hiddenImports)) store.layers.hiddenImports=[];
  if(!Array.isArray(store.layers.hiddenPlotNames)) store.layers.hiddenPlotNames=[];
  if(!store.disp) store.disp={};
  for(const k in DEFAULT_DISP) if(store.disp[k]===undefined) store.disp[k]=DEFAULT_DISP[k];
  for(const k in DEFAULT_SETTINGS)
    if(store.settings[k]===undefined) store.settings[k]=DEFAULT_SETTINGS[k];
  if(store.settings.siteMax===undefined) store.settings.siteMax=SITE_MAX_DEFAULT;
  stakeList();
  if(!stakeList().includes(store.settings.stake)) store.settings.stake=stakeList()[0];
}
async function readSite(id){
  try{
    const j=await idbGet(DB_STORE, siteKey(id));
    if(j){ const d=JSON.parse(j); if(isFukugenData(d)) return d; }
  }catch(e){}
  return null;
}
/* 現場を切り替えたあとの画面の作り直し */
function afterSiteChange(){
  applyFontScale();
  updateSiteChip(); updateProg(); updateListCount(); updateActionbar(); renderRibbon();
  state.viewRestored = restoreView();
  if(!state.viewRestored && store.points.length)
    fitToBox(store.points.map(p=>p.x), store.points.map(p=>p.y));
  draw();
  if(panelOpen('sitePanel')) renderSites();
  if(panelOpen('layerPanel')) openLayers();
  if(panelOpen('listPanel')) openList();
}
async function switchSite(id){
  const s=siteById(id);
  if(!s || id===sites.active) return false;
  await flushNow();
  sites.active=id;
  const d=await readSite(id);
  resetStoreData();
  applyLoaded(d);
  fillDefaults();
  clearUndoStacks();
  lastSavedJson=siteJson();
  await saveSites();
  afterSiteChange();
  toast(`現場「${s.name}」を開きました`);
  return true;
}
/* payload を渡すと、その中身で現場を作る（控えから新しい現場として読む） */
async function createSite(name, payload){
  if(siteFull()){
    alert(`現場は${siteMax()}件までです。\n\nどれかを削除するか、「準備」タブの［各種設定］で上限を増やしてください。`);
    return null;
  }
  await flushNow();
  const zone=store.settings.zone;          // ふつう次の現場も同じ系なので引き継ぐ
  const id=newId();
  const now=new Date().toISOString();
  const rec={ id, name:(name||'').trim()||`現場${siteList().length+1}`,
              created:now, updated:now, pts:0, done:0, lines:0 };
  siteList().push(rec);
  sites.active=id;
  resetStoreData();
  store.settings.zone=zone;
  if(payload) applyLoaded(payload);
  fillDefaults();
  clearUndoStacks();
  lastSavedJson='';
  savePending=true; await flushSave();
  afterSiteChange();
  return rec;
}
async function renameSite(id, name){
  const s=siteById(id);
  const v=String(name||'').trim();
  if(!s || !v) return false;
  s.name=v;
  await saveSites();
  updateSiteChip(); renderRibbon();
  if(panelOpen('sitePanel')) renderSites();
  return true;
}
async function removeSite(id){
  const s=siteById(id);
  if(!s) return false;
  if(siteList().length<=1){
    alert('最後の1件は削除できません。\n\n中身だけ消したいときは「データ」タブの［この現場を空にする］をお使いください。');
    return false;
  }
  if(!confirm(`【削除するもの】現場「${s.name}」の中身すべて\n`
    + `　境界点${s.pts||0}（記録済み${s.done||0}）／画地${s.lines||0}／その現場の自動控え\n`
    + `【残るもの】ほかの現場、杭種・作業者名などの端末の設定、地図の控え\n`
    + `【元に戻せるか】戻せません\n\n削除しますか?`)) return false;
  try{ await idbReq(DB_STORE,'readwrite',st=>st.delete(siteKey(id))); }catch(e){}
  await deleteSnapshotsOf(id);
  sites.list=siteList().filter(x=>x.id!==id);
  if(sites.active===id){
    const next=siteList()[0];
    sites.active=next.id;
    const d=await readSite(next.id);
    resetStoreData(); applyLoaded(d); fillDefaults(); clearUndoStacks();
    lastSavedJson=siteJson();
    await saveSites();
    afterSiteChange();
  } else {
    await saveSites();
    if(panelOpen('sitePanel')) renderSites();
    renderRibbon();
  }
  toast(`現場「${s.name}」を削除しました`);
  return true;
}
function updateSiteChip(){
  const el=document.getElementById('siteChip');
  if(!el) return;
  const n=activeSiteName();
  el.textContent = n || '—';
  el.title = `いま開いている現場（${siteList().length}/${siteMax()}件）`;
}

function isFukugenData(d){
  if(!d || !d.settings || !Array.isArray(d.points) || !Array.isArray(d.routes)
     || !Array.isArray(d.imports) || !Array.isArray(d.lines)) return false;
  return !d.appId || d.appId===APP_STORAGE_ID; // appIdなしはv0.1〜v0.2の境界復元データ
}
function applyLoaded(d){
  if(!isFukugenData(d)) return false;
  Object.assign(store.settings, d.settings||{});
  Object.assign(store.layers, d.layers||{});
  store.points   = d.points||[];
  for(const p of store.points){
    if(p&&p.rec&&p.rec.s) p.rec.s=normalizeStakeName(p.rec.s);
    if(p&&p.stake) p.stake=normalizeStakeName(p.stake);
  }
  store.refPoints= d.refPoints||[];
  store.lines    = d.lines||[];
  store.routes   = d.routes||[];
  store.strokes  = d.strokes||[];
  store.imports  = d.imports||[];
  store.appId = APP_STORAGE_ID;
  store.disp = Object.assign({}, DEFAULT_DISP, d.disp||{});
  invalidatePtMap(); invalidatePlotMap();
  return true;
}
async function load(){
  /* 1) 端末で共通の設定 → 2) 現場の目録 → 3) いまの現場の中身 の順に読む */
  try{
    const j=await idbGet(DB_STORE, DEVICE_KEY);
    if(j){ const d=JSON.parse(j); if(d && d.settings) Object.assign(store.settings, d.settings); }
  }catch(e){}
  try{
    const j=await idbGet(DB_STORE, SITES_KEY);
    if(j){ const d=JSON.parse(j); if(d && Array.isArray(d.list) && d.list.length) sites=d; }
  }catch(e){}

  let migrated=false;
  if(!siteList().length){
    /* v0.6までの1現場ぶんを「現場１」へ移す。無ければ空の「現場１」を作る */
    let legacy=null;
    try{
      const j=await idbGet(DB_STORE, DB_KEY);
      if(j){ const d=JSON.parse(j); if(isFukugenData(d)) legacy=d; }
    }catch(e){}
    if(!legacy){
      try{
        const raw=localStorage.getItem(LS_KEY) || localStorage.getItem(LEGACY_LS_KEY);
        if(raw){ const d=JSON.parse(raw); if(isFukugenData(d)) legacy=d; }
      }catch(e){}
    }
    const id=newId(), now=new Date().toISOString();
    sites={ list:[{ id, name:'現場１', created:now, updated:now, pts:0, done:0, lines:0 }], active:id };
    if(legacy) applyLoaded(legacy);      // 端末共通の設定も旧データから引き継ぐ
    migrated=true;
  } else {
    if(!siteById(sites.active)) sites.active=siteList()[0].id;
    applyLoaded(await readSite(sites.active));
  }

  fillDefaults();
  applyFontScale();
  if(migrated){
    await adoptOldSnapshots(sites.active);
    lastSavedJson='';
    savePending=true;
    await flushSave();
  } else {
    lastSavedJson=siteJson();
  }
  requestPersist();
}
<!--@SRC:1349-1356-->
async function showStorageInfo(){
  let mode='localStorage（IndexedDB非対応）', persisted='不明', usage='不明', snaps='0';
  try{ await idb(); mode='IndexedDB'; }catch(e){}
  try{
    if(navigator.storage){
      if(navigator.storage.persisted) persisted=(await navigator.storage.persisted())?'あり（自動削除されにくい）':'なし（ホーム画面に追加すると付与されやすくなります）';
      if(navigator.storage.estimate){
        const es=await navigator.storage.estimate();
        usage=`${(es.usage/1048576).toFixed(1)}MB / 上限の目安 ${(es.quota/1048576).toFixed(0)}MB`;
      }
    }
  }catch(e){}
  try{ snaps=String((await idbReq('snapshots','readonly',s=>s.getAllKeys())).length); }catch(e){}
  const tinfo = await tileCacheInfo();
  const tileLine = tinfo.count
    ? `${tinfo.count}枚 / 約${(tinfo.bytes/1048576).toFixed(1)}MB（上限 ${(TILE_MAX_BYTES/1048576).toFixed(0)}MB・超えると古い順に自動削除）`
    : 'なし（レイヤ画面の［この範囲を圏外用に控える］で保存できます）';
  let offline='未対応（HTTPSで開いていない可能性があります）';
  try{
    if(window.caches){
      const key=(await caches.keys()).find(k=>k.startsWith('kyokai-fukugen-map-'));
      if(!key) offline='未設定（sw.js が同じフォルダにあるか確認してください）';
      else{
        const c=await caches.open(key);
        offline=(await c.match(location.href.split('#')[0],{ignoreSearch:true}))
          ? '準備済み（この端末は圏外でも起動できます）'
          : 'まだ（電波のある場所でもう一度開いてください）';
      }
    }
  }catch(e){}
  const c=progCounts(), le=store.settings.lastExport;
  const siteLine = siteList().map(x=>
    `　${x.id===sites.active?'▶':'　'} ${x.name}（${x.pts||0}点／記録${x.done||0}）`).join('\n');
  alert('保存状態\n\n'
    +`アプリ: ${appFull()}\n`
    +`ビルド: ${APP_BUILD}\n\n`
    +`保存方式: ${mode}\n`
    +`専用保存領域: ${DB_NAME}\n`
    +`永続化: ${persisted}\n`
    +`オフライン起動: ${offline}\n`
    +`使用量: ${usage}\n`
    +`地図の控え: ${tileLine}\n`
    +`自動バックアップ: ${snaps}世代\n`
    +`最後のJSONバックアップ: ${le?le:'まだ保存していません'}\n\n`
    +`現場: ${siteList().length}/${siteMax()}件\n${siteLine}\n\n`
    +`いま開いている現場「${activeSiteName()}」\n`
    +`境界点 ${c.all}点（打設${c.da} / 既設${c.ki} / 未${c.no}）\n`
    +`画地の線 ${store.lines.length}／計測線 ${store.routes.length}／基準点 ${store.refPoints.length}／メモ ${store.strokes.length}\n\n`
    +'※端末内の保存は端末の故障・初期化で失われます。作業終了時にJSONバックアップを端末外へ保存してください。');
}
<!--@SRC:1401-1407-->

/* ================= 警告バー ================= */
<!--@SRC:1410-1421-->

/* ================= キャンバス ================= */
<!--@SRC:1424-1438-->

/* ================= 描画 =================
   下から順に: 背景地図 → 図面 → 手書きメモ → 画地の線 → 計測線 → 距離 →
               基準点 → 境界点 → 現在地
   点が多いときは、まず画面に入っている数を数えて出し方を決める（点だけ／点／点名つき）。 */
function inView(sx,sy,m){ const k=m||30; return sx>=-k && sx<=W+k && sy>=-k && sy<=H+k; }
function visiblePointCount(){
  let n=0;
  for(const p of store.points){
    if(!isPointVisible(p)) continue;
    const [x,y]=toScr(p.x,p.y);
    if(inView(x,y)) n++;
    if(n>20000) break;
  }
  return n;
}
function drawMode(n){
  const lim = Math.max(20, +store.settings.thinPt||300);
  const lim2= Math.max(10, +store.settings.thinName||150);
  if(n>lim) return 'dot';
  return n<=lim2 ? 'name' : 'mark';
}
function draw(){
  clearLabelBoxes();
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#d8d8d8'; ctx.fillRect(0,0,W,H);
  drawBaseMap();
  if(state.tiff && store.layers.base!==false){
    const mag=state.view.scale/nativePPU();
    ctx.imageSmoothingEnabled = mag < 2;
    ctx.imageSmoothingQuality='high';
    ctx.save();
    ctx.globalAlpha = tiffAlpha();
    for(const t of visibleTiffs()) drawGeoLayer(t);
    if(state.detail) drawGeoLayer(state.detail);
    ctx.restore();
    scheduleDetail();
  }
  if(store.layers.memo!==false) for(const s of store.strokes){
    ctx.strokeStyle=s.color; ctx.lineWidth=Math.max(1,s.w*state.view.scale);
    ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath();
    s.pts.forEach((p,i)=>{ const [x,y]=toScr(p[0],p[1]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke();
  }
  const idx = ptIndex();
  const showDist = store.layers.dist!==false;
  const distMin = Math.max(10, +store.settings.thinDist||40);
  const distPx = labelFont('distSize');
  /* --- 画地の線（塗らない。同じ点を何度も通る一筆書きのため） --- */
  ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.lineWidth=+disp('lineWidth')||2;
  ctx.setLineDash([]);
  const distJobs=[], plotJobs=[];
  const namesOn = isPlotNameOn();
  const plotPx = labelFont('plotNameSize');
  for(const l of store.lines){
    if(!isLineVisible(l)) continue;
    const ids=l.ptIds, n=ids.length;
    if(n<2) continue;
    const segs = l.closed ? n : n-1;
    /* 画地名（地番）を置く場所を決めるための材料。
       edges … 画地線をぜんぶ（画面の外の分も）ためておく。
               これが「囲まれた中」を割り出すもとになる。
       vis   … 画面に見えている線。中が取れなかったときの逃げ場。 */
    const edges=[], vis=[];
    const showPlotName = namesOn && isPlotNameVisible(l);
    ctx.strokeStyle=lineColorOf(l);      /* 取込ファイルごとの色。無ければ種類別の色 */
    ctx.beginPath();
    for(let i=0;i<segs;i++){
      const a=idx.get(ids[i]), b=idx.get(ids[(i+1)%n]);
      if(!a||!b) continue;
      const A=toScr(a.x,a.y), B=toScr(b.x,b.y);
      if(showPlotName) edges.push(A[0],A[1],B[0],B[1]);
      if(!segOnScreen(A,B)) continue;
      ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]);
      if(showPlotName){
        const c=clipSeg(A,B);
        if(c){
          const len=Math.hypot(c[1][0]-c[0][0], c[1][1]-c[0][1]);
          if(len>0) vis.push({ a:c[0], b:c[1], len });
        }
      }
      if(showDist){
        const px=Math.hypot(B[0]-A[0],B[1]-A[1]);
        if(px>=distMin){
          const d=l.dists && isFinite(l.dists[i]) ? l.dists[i] : distBetween(a,b);
          distJobs.push([A,B,fmtDist(d)]);
        }
      }
    }
    ctx.stroke();
    if(showPlotName){
      const text=plotLabelText(l);
      ctx.font='bold '+plotPx+'px sans-serif';
      const cands = plotLabelAnchors(edges, vis, plotPx, ctx.measureText(text).width);
      if(cands.length) plotJobs.push([cands, text, plotNameColorOf(l)]);
    }
  }
  /* 画地名は数が少なく、いまどの画地を見ているかの手がかりになるので、
     場所の取り合いでは点名や距離より先に確保する（描くのは最後＝いちばん手前）。 */
  const plotDraw=[];
  if(namesOn && plotJobs.length){
    const px=plotPx;
    ctx.font='bold '+px+'px sans-serif';
    for(const [cands, text, col] of plotJobs){
      const w=ctx.measureText(text).width, h=px+4;
      /* 真ん中が他のラベルで埋まっていたら、その画地の内側の別のところへ逃がす */
      for(const at of cands){
        const cx=Math.min(W-w/2-4, Math.max(w/2+4, at[0]));
        const cy=Math.min(H-h/2-4, Math.max(h/2+4, at[1]));
        if(placeLabel(cx, cy, w+10, h+6)){ plotDraw.push([cx, cy, text, px, col]); break; }
      }
    }
  }
  /* --- 計測線 --- */
  ctx.strokeStyle=disp('routeColor'); ctx.lineWidth=+disp('routeWidth')||3;
  if(store.layers.route!==false) for(const r of store.routes){
    const ids=r.ptIds||[];
    if(ids.length<2) continue;
    ctx.beginPath();
    let started=false;
    for(let i=0;i<ids.length;i++){
      const p=idx.get(ids[i]); if(!p) continue;
      const [x,y]=toScr(p.x,p.y);
      started ? ctx.lineTo(x,y) : (ctx.moveTo(x,y), started=true);
    }
    ctx.stroke();
    if(showDist) for(let i=0;i<ids.length-1;i++){
      const a=idx.get(ids[i]), b=idx.get(ids[i+1]);
      if(!a||!b) continue;
      const A=toScr(a.x,a.y), B=toScr(b.x,b.y);
      if(!segOnScreen(A,B)) continue;
      if(Math.hypot(B[0]-A[0],B[1]-A[1])>=distMin) distJobs.push([A,B,fmtDist(distBetween(a,b))]);
    }
  }
  /* --- 計測中の線 --- */
  if(state.currentRoute.length){
    const pts = state.currentRoute.map(id=>idx.get(id)).filter(Boolean);
    ctx.strokeStyle='#ff8c00'; ctx.lineWidth=4; ctx.setLineDash([8,5]);
    ctx.beginPath();
    pts.forEach((p,i)=>{ const [x,y]=toScr(p.x,p.y); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke(); ctx.setLineDash([]);
    for(const p of pts){ const [x,y]=toScr(p.x,p.y);
      ctx.strokeStyle='#ff8c00'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(x,y,11,0,7); ctx.stroke(); }
    for(let i=0;i<pts.length-1;i++){
      const A=toScr(pts[i].x,pts[i].y), B=toScr(pts[i+1].x,pts[i+1].y);
      if(Math.hypot(B[0]-A[0],B[1]-A[1])>=24) distJobs.push([A,B,fmtDist(distBetween(pts[i],pts[i+1]))]);
    }
  }
  /* --- 基準点（参考。蛍光緑の丸十字） --- */
  if(store.layers.ref!==false){
    const r=7*sizeMul('refMarkSize');
    for(const p of store.refPoints){
      if(!isRefVisible(p)) continue;
      const [x,y]=toScr(p.x,p.y);
      if(!inView(x,y)) continue;
      ctx.fillStyle=disp('refColor'); ctx.strokeStyle=REF_STROKE; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x-r,y); ctx.lineTo(x+r,y); ctx.moveTo(x,y-r); ctx.lineTo(x,y+r);
      ctx.stroke();
      labelNoOverlap(x, y-r-5, p.name, REF_LABEL, labelFont('refNameSize'));
    }
  }
  /* --- 境界点 --- */
  const nvis = visiblePointCount();
  const dm = drawMode(nvis);
  state.drawInfo = { n:nvis, mode:dm };
  if(store.layers.pt!==false){
    const pr = 6*sizeMul('ptMarkSize');
    const nf = labelFont('ptNameSize');
    for(const p of store.points){
      if(!isPointVisible(p)) continue;
      const [x,y]=toScr(p.x,p.y);
      if(!inView(x,y)) continue;
      const k=stOf(p), col=stColor(k);
      if(dm==='dot'){
        ctx.fillStyle=col;
        ctx.beginPath(); ctx.arc(x,y,2.5,0,7); ctx.fill();
        continue;
      }
      ctx.lineWidth=2;
      if(k==='no'){ ctx.fillStyle='#fff'; ctx.strokeStyle=col; }
      else        { ctx.fillStyle=col;    ctx.strokeStyle='#fff'; }
      ctx.beginPath(); ctx.arc(x,y,pr,0,7); ctx.fill(); ctx.stroke();
      if(dm==='name') labelNoOverlap(x, y-pr-6, displayPointName(p), k==='no'?'#5a6068':col, nf);
    }
  }
  /* --- 距離（線の上に、線に沿って）---
     点名のほうが「いまどの点を記録するか」に直結するので、
     場所の取り合いになったときは点名を優先して距離を落とす。 */
  for(const [A,B,t] of distJobs) drawDistLabel(A,B,t,distPx);
  /* --- 画地名（地番）--- */
  for(const [cx,cy,text,px,col] of plotDraw) drawPlotName(cx,cy,text,px,col);
  if(state.gps.ok){
    const [x,y]=toScr(state.gps.x,state.gps.y);
    const [ax,ay]=accToMapUnitsXY(state.gps.acc);
    const rx=Math.max(ax*state.view.scale,4), ry=Math.max(ay*state.view.scale,4);
    ctx.fillStyle='rgba(30,115,210,.15)'; ctx.strokeStyle='rgba(30,115,210,.5)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,7); ctx.fill(); ctx.stroke();
    ctx.fillStyle='#1e73d2'; ctx.strokeStyle='#fff'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.arc(x,y,8,0,7); ctx.fill(); ctx.stroke();
  }
  drawScaleBar();
  drawCredit();
  updateZoomLabel();
  updateHint();
}
/* ================= 画地名（地番）の置き場所 =================
   D00の区画名（地番が入っていればそれ）を、画地ごとに1つだけ出す。
   置くのは線の上ではなく、**画地線で囲まれた中（内側）**。
   ・画地が丸ごと画面に入っているとき … その画地の内側の真ん中
   ・はみ出しているとき（拡大時）     … 画面に見えている**内側**の真ん中
   内側の探し方は「横に引いた線が画地線と何回交わるか」で決める（偶奇判定）。
   横向きの文字を置くので、横にいちばん広く空いているところを選ぶ。
   囲まれた中が取れない画地（線が閉じていない・一筆書きで往復しているなど）
   だけは、これまでどおり見えている線の上へ逃がす。 */
const PLOT_LABEL_MIN_PX = 60;      // 見えている線がこれより短ければ出さない
const PLOT_LABEL_SCANS  = 21;      // 内側を探すときに横へ引く線の本数
const PLOT_LABEL_MIN_W  = 22;      // 内側がこれより狭ければ置かない（画面px）
function plotLabelText(l){
  const s=String(l.name==null?'':l.name).trim();
  return s || `画地${l.no}`;
}
function onScreen(P){ return P[0]>=0 && P[0]<=W && P[1]>=0 && P[1]<=H; }
/* 線分を画面の矩形で切り取る（Liang-Barsky）。見えている部分だけを返す */
function clipSeg(A,B){
  let t0=0, t1=1;
  const dx=B[0]-A[0], dy=B[1]-A[1];
  const p=[-dx, dx, -dy, dy];
  const q=[A[0]-0, W-A[0], A[1]-0, H-A[1]];
  for(let i=0;i<4;i++){
    if(p[i]===0){ if(q[i]<0) return null; continue; }
    const r=q[i]/p[i];
    if(p[i]<0){ if(r>t1) return null; if(r>t0) t0=r; }
    else       { if(r<t0) return null; if(r<t1) t1=r; }
  }
  return [[A[0]+t0*dx, A[1]+t0*dy], [A[0]+t1*dx, A[1]+t1*dy]];
}
/* 画地の内側で、横にいちばん広く空いているところを探す。
   横線を PLOT_LABEL_SCANS 本引き、画地線との交点を左から並べて
   「1本目と2本目のあいだ」「3本目と4本目のあいだ」…を内側とみなす（偶奇判定）。
   その区間を画面の中へ切り詰めるので、拡大しても地番は画面の中に残る。 */
function plotInsideAnchors(edges, px, textW){
  const out=[];
  if(edges.length<12) return out;                 // 3辺に満たなければ囲めない
  let y0=Infinity, y1=-Infinity;
  for(let i=1;i<edges.length;i+=2){
    const y=edges[i];
    if(y<y0) y0=y;
    if(y>y1) y1=y;
  }
  const h=px+10, pad=4;
  y0=Math.max(y0, pad+h/2); y1=Math.min(y1, H-pad-h/2);
  if(!(y1>y0)) return out;
  const need=Math.max(PLOT_LABEL_MIN_W, textW+12);
  const midY=(y0+y1)/2, half=(y1-y0)/2 || 1;
  const hits=[], xs=[];
  for(let s=0;s<PLOT_LABEL_SCANS;s++){
    const y = y0 + (y1-y0)*(s+0.5)/PLOT_LABEL_SCANS;
    xs.length=0;
    for(let i=0;i<edges.length;i+=4){
      const ay=edges[i+1], by=edges[i+3];
      if((ay<=y)===(by<=y)) continue;             // またいでいない辺は関係ない
      xs.push(edges[i] + (edges[i+2]-edges[i])*(y-ay)/(by-ay));
    }
    if(xs.length<2) continue;
    xs.sort((a,b)=>a-b);
    for(let k=0;k+1<xs.length;k+=2){
      const a=Math.max(xs[k], pad), b=Math.min(xs[k+1], W-pad);
      const w=b-a;
      if(w<PLOT_LABEL_MIN_W) continue;
      const fit=Math.min(1, w/need);              // 文字が収まるか（1なら十分）
      const near=1-0.5*Math.abs(y-midY)/half;     // 上下の真ん中に近いほうがよい
      hits.push({ x:(a+b)/2, y, sc:fit*fit*near });
    }
  }
  if(!hits.length) return out;
  hits.sort((p,q)=>q.sc-p.sc);
  for(const p of hits){
    if(out.length>=6) break;
    if(out.some(o=>Math.abs(o[0]-p.x)<24 && Math.abs(o[1]-p.y)<24)) continue;
    out.push([p.x,p.y]);
  }
  return out;
}
/* 置きたい順に候補を返す。前のものが他のラベルとぶつかったら次を使う。
   1〜 … 画地線で囲まれた中（広いところから順に）
   最後 … 中が取れなかったときだけ、見えている画地線の上 */
/* 線の上をずらす順番。真ん中から始めて、ふさがっていたら前後へ逃げる */
const PLOT_LABEL_SLIDE = [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875];
function plotLabelAnchors(edges, vis, px, textW){
  const out=plotInsideAnchors(edges, px, textW||0);
  let total=0;
  for(const s of vis) total+=s.len;
  if(total >= PLOT_LABEL_MIN_PX){
    for(const f of PLOT_LABEL_SLIDE){
      const at = lineFractionPoint(vis, total, f);
      if(at) out.push(at);
    }
  }
  return out;
}
function visibleLineMidpoint(vis){
  let total=0;
  for(const s of vis) total+=s.len;
  if(total < PLOT_LABEL_MIN_PX) return null;
  return lineFractionPoint(vis, total, 0.5);
}
/* 見えている線を端からたどって、全長の f 倍のところの座標を返す */
function lineFractionPoint(vis, total, f){
  let rest = total * f;
  for(const s of vis){
    if(rest<=s.len){
      const t = s.len ? rest/s.len : 0;
      return [s.a[0]+(s.b[0]-s.a[0])*t, s.a[1]+(s.b[1]-s.a[1])*t];
    }
    rest-=s.len;
  }
  const last=vis[vis.length-1];
  return last ? [last.b[0], last.b[1]] : null;
}
/* 線の上に重なっても読めるよう、白い縁取りの上に書く */
function drawPlotName(cx, cy, text, px, col){
  ctx.font='bold '+px+'px sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  const w=ctx.measureText(text).width, h=px+4;
  ctx.fillStyle='rgba(255,255,255,.78)';
  ctx.fillRect(cx-w/2-5, cy-h/2-3, w+10, h+6);
  ctx.lineWidth=3; ctx.strokeStyle='#fff'; ctx.strokeText(text, cx, cy);
  ctx.fillStyle=col||disp('plotNameColor'); ctx.fillText(text, cx, cy);
  ctx.textBaseline='alphabetic';
}

/* --- 文字の重なりよけ ---
   点名や距離をそのまま全部書くと、密なところで文字が重なって読めなくなる。
   すでに書いた場所を覚えておき、ぶつかるものは書かない（拡大すれば出てくる）。 */
let labelBoxes=[];
function clearLabelBoxes(){ labelBoxes=[]; }
function placeLabel(cx, cy, w, h){
  const x0=cx-w/2-1, x1=cx+w/2+1, y0=cy-h/2-1, y1=cy+h/2+1;
  for(const b of labelBoxes){
    if(x0<b[2] && x1>b[0] && y0<b[3] && y1>b[1]) return false;
  }
  labelBoxes.push([x0,y0,x1,y1]);
  return true;
}
/* 線分が画面に掛かっているか（掛かっていない辺は距離も線も作らない） */
function segOnScreen(A,B){
  const m=60;
  if(A[0]< -m && B[0]< -m) return false;
  if(A[0]>W+m && B[0]>W+m) return false;
  if(A[1]< -m && B[1]< -m) return false;
  if(A[1]>H+m && B[1]>H+m) return false;
  return true;
}
/* 距離は線に沿って書く。上下がひっくり返らないよう角度を折り返す */
function drawDistLabel(A,B,text,px){
  const cx=(A[0]+B[0])/2, cy=(A[1]+B[1])/2;
  ctx.font='bold '+(px||12)+'px sans-serif';
  const w=ctx.measureText(text).width, h=(px||12)+4;
  /* 線に沿って傾くので、当たり判定は縦横の長い方で見る（多めに見て重なりを避ける） */
  const m=Math.max(w,h);
  if(!placeLabel(cx, cy, Math.min(w+6,m), Math.min(h+4,m))) return;
  let ang=Math.atan2(B[1]-A[1], B[0]-A[0]);
  if(ang> Math.PI/2) ang-=Math.PI;
  if(ang<-Math.PI/2) ang+=Math.PI;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.lineWidth=3; ctx.strokeStyle='#fff'; ctx.strokeText(text,0,-2);
  ctx.fillStyle=disp('distColor'); ctx.fillText(text,0,-2);
  ctx.restore();
  ctx.textBaseline='alphabetic';
}
<!--@SRC:1553-1562-->
/* いまの表示に見合った地図の細かさ（ズーム段）。
   drawBaseMap は上限・下限で丸めた値しか残さないので、
   「その年代には無い細かさを求めている」かどうかは、丸める前の値で見る。 */
function wantedTileZoom(){
  if(state.geographic) return null;
  try{
    const pr=currentProj();
    const lats=[[0,0],[W,0],[0,H],[W,H]].map(([sx,sy])=>{
      const m=toMap(sx,sy);
      const ll=pr.inverse([m[0],m[1]]);
      return ll && ll[1];
    });
    if(lats.some(v=>!isFinite(v))) return null;
    const latC=(Math.min(...lats)+Math.max(...lats))/2;
    if(Math.abs(latC)>85) return null;
    return tileZoomFor(latC);
  }catch(e){ return null; }
}
/* 重なるなら書かない点名 */
function labelNoOverlap(x,y,text,color,px){
  ctx.font='bold '+(px||12)+'px sans-serif';
  const w=ctx.measureText(text).width, h=(px||12)+2;
  if(!placeLabel(x, y-h/2, w+4, h+2)) return;
  label(x,y,text,color,px);
}
/* 画面右上の案内（点だけ表示にしているとき・航空写真の限界を超えたとき） */
function updateHint(){
  const el=document.getElementById('fixBar');
  if(!el) return;
  const msgs=[];
  const def=baseMapDef();
  const z=wantedTileZoom();
  if(def.url && z!==null){
    if(z > def.max)
      msgs.push(`これ以上は細かくなりません<span class="sub">${esc(def.name)}</span>`);
    else if(z < def.min)
      msgs.push(`もっと拡大すると出ます<span class="sub">${esc(def.name)}</span>`);
  }
  if(state.drawInfo.mode==='dot' && state.drawInfo.n)
    msgs.push(`点だけ表示（${state.drawInfo.n}点）<span class="sub">拡大すると点名まで出ます</span>`);
  if(!msgs.length){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='block';
  el.style.background='rgba(30,58,95,.90)';
  el.innerHTML=msgs.join('<br>');
}
/* ヘッダーは狭いので数字だけ。内訳は大ボタンと一覧に出す */
function updateProg(){
  const el=document.getElementById('progChip');
  if(!el) return;
  const c=progCounts();
  if(!c.all){ el.textContent='—'; el.title='境界点を取り込んでください'; return; }
  el.textContent=`${c.done}/${c.all}`;
  el.title=`${c.all}点中 ${c.done}点を記録（打設${c.da}／既設${c.ki}／未${c.no}）`;
}

/* ================= TIFFの画素読込 ================= */
<!--@SRC:1564-1791-->

/* ================= 拡大縮小 ================= */
<!--@SRC:1792-1829-->

/* ================= 操作 ================= */
<!--@SRC:1831-1899-->
function onTap(sx,sy){
  if(state.mode==='rec'){
    const p=nearestPoint(sx,sy,TOUCH_HIT_RADIUS,false);
    if(p){ openRec(p.id); return; }
    if(nearestRef(sx,sy,TOUCH_HIT_RADIUS)){ toast('基準点は復元の対象外です'); return; }
    if(store.settings.mockGps){ const m=toMap(sx,sy); setMockGpsAt(m[0],m[1]); return; }
    toast('境界点をタップしてください');
    return;
  }
  if(state.mode==='line'){
    const p=nearestPoint(sx,sy,TOUCH_HIT_RADIUS,true);
    if(p){
      const cr=state.currentRoute;
      if(cr[cr.length-1]===p.id){ toast('同じ点が続いています'); return; }
      cr.push(p.id);
      updateActionbar(); draw();
      return;
    }
    if(store.settings.mockGps){ const m=toMap(sx,sy); setMockGpsAt(m[0],m[1]); return; }
    if(state.currentRoute.length===0){
      const r=routeAt(sx,sy,14);
      if(r) delRoute(r.id);
    }
    return;
  }
  if(store.settings.mockGps && state.mode!=='memo'){
    const m=toMap(sx,sy); setMockGpsAt(m[0],m[1]);
  }
}
/* 擬似GPS（手動現在地）の位置を動かす */
function setMockGpsAt(x,y){
  Object.assign(state.gps,{ok:true,acc:0.5,x,y});
  if(!state.geographic){
    try{ const ll=currentProj().inverse([x,y]); state.gps.lon=ll[0]; state.gps.lat=ll[1]; }catch(e){}
  } else { state.gps.lon=x; state.gps.lat=y; }
  updateGpsLabel(); draw();
}
/* いちばん近い境界点。withRef=true なら基準点も相手にする（計測用） */
function nearestPoint(sx,sy,thr,withRef){
  let best=null, bd=thr;
  for(const p of store.points){
    if(!isPointVisible(p)) continue;
    const [x,y]=toScr(p.x,p.y);
    if(!inView(x,y,thr)) continue;
    const d=Math.hypot(x-sx,y-sy);
    if(d<bd){ bd=d; best=p; }
  }
  if(withRef) for(const p of store.refPoints){
    if(!isRefVisible(p)) continue;
    const [x,y]=toScr(p.x,p.y);
    if(!inView(x,y,thr)) continue;
    const d=Math.hypot(x-sx,y-sy);
    if(d<bd){ bd=d; best=p; }
  }
  return best;
}
function nearestRef(sx,sy,thr){
  let best=null, bd=thr;
  for(const p of store.refPoints){
    if(!isRefVisible(p)) continue;
    const [x,y]=toScr(p.x,p.y);
    if(!inView(x,y,thr)) continue;
    const d=Math.hypot(x-sx,y-sy);
    if(d<bd){ bd=d; best=p; }
  }
  return best;
}
function routeAt(sx,sy,thr){
  if(store.layers.route===false) return null;
  const idx=ptIndex();
  for(const r of store.routes){
    const pts=(r.ptIds||[]).map(id=>idx.get(id)).filter(Boolean);
    for(let i=0;i<pts.length-1;i++){
      const a=toScr(pts[i].x,pts[i].y), b=toScr(pts[i+1].x,pts[i+1].y);
      if(distToSeg(sx,sy,a,b)<thr) return r;
    }
  }
  return null;
}
<!--@SRC:1979-1997-->

/* ================= GPS ================= */
<!--@SRC:2000-2055-->
let gpsErrShown=false;
function startGps(){
  if(store.settings.mockGps){ gpsInfo.innerHTML='手動位置: 地図をタップ'; return; }
  if(!navigator.geolocation){ gpsInfo.textContent='GPS: 非対応'; return; }
  navigator.geolocation.watchPosition(pos=>{
    if(store.settings.mockGps) return;
    const {latitude:lat, longitude:lon, accuracy:acc}=pos.coords;
    let x,y;
    try{ [x,y]=gpsToMap(lon,lat); }catch(e){ return; }
    const first=!state.gps.ok;
    Object.assign(state.gps,{ok:true,lat,lon,acc,x,y});
    updateGpsLabel();
    if(state.follow||(first&&!state.tiff&&!state.viewRestored&&!store.points.length)){
      state.view.cx=x; state.view.cy=y;
    }
    if(first && !state.tiff && !state.viewRestored && !store.points.length && state.view.scale<=1.0001)
      state.view.scale=clampScale(3);
    if(first) checkZone(lon, lat);
    draw();
  }, err=>{
    /* ヘッダーは1行に収める。詳しい案内は1度だけトーストで出す */
    gpsInfo.textContent = 'GPS: '+(err.code===1?'許可なし':'取得失敗');
    if(!gpsErrShown){
      gpsErrShown = true;
      setTimeout(()=>toast(err.code===1
        ? '位置情報が許可されていません（PCでは「確認」タブの擬似GPSが使えます）'
        : '位置情報を取得できませんでした'), 900);
    }
  }, {enableHighAccuracy:true, maximumAge:1000, timeout:20000});
}
document.getElementById('followBtn').addEventListener('click',()=>{
  state.follow=!state.follow; updateFollowBtn();
  if(state.follow && state.gps.ok){ state.view.cx=state.gps.x; state.view.cy=state.gps.y; draw(); }
});
function updateFollowBtn(){ document.getElementById('followBtn').classList.toggle('on',state.follow); }

/* ================= ファイル選択 ================= */
<!--@SRC:2085-2221-->

/* ================= 背景地図（地理院タイル・年代別空中写真つき） =================
   出典: 地理院タイル（国土地理院） https://maps.gsi.go.jp/development/ichiran.html
   年代別の空中写真は、年代によって作られている拡大段階（ズーム）の上限が違う。
   上限を超えて拡大したときは画面右上で知らせる（同じ画像を引き伸ばした表示になるため）。 */
const GSI_TILES = {
  std:   { name:'標準地図',   url:'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',           min:2,  max:18 },
  pale:  { name:'淡色地図',   url:'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',          min:2,  max:18 },
  photo: { name:'空中写真（最新）',      url:'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', min:2,  max:18 },
  ort:   { name:'空中写真 2007年〜',     url:'https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg',           min:14, max:18 },
  gazo4: { name:'空中写真 1987〜1990年', url:'https://cyberjapandata.gsi.go.jp/xyz/gazo4/{z}/{x}/{y}.jpg',         min:10, max:17 },
  gazo3: { name:'空中写真 1984〜1986年', url:'https://cyberjapandata.gsi.go.jp/xyz/gazo3/{z}/{x}/{y}.jpg',         min:10, max:17 },
  gazo2: { name:'空中写真 1979〜1983年', url:'https://cyberjapandata.gsi.go.jp/xyz/gazo2/{z}/{x}/{y}.jpg',         min:10, max:17 },
  gazo1: { name:'空中写真 1974〜1978年', url:'https://cyberjapandata.gsi.go.jp/xyz/gazo1/{z}/{x}/{y}.jpg',         min:10, max:17 },
  ort_old10:{ name:'空中写真 1961〜1969年',        url:'https://cyberjapandata.gsi.go.jp/xyz/ort_old10/{z}/{x}/{y}.png', min:10, max:17 },
  ort_USA10:{ name:'空中写真 1945〜1950年（米軍）', url:'https://cyberjapandata.gsi.go.jp/xyz/ort_USA10/{z}/{x}/{y}.png', min:10, max:17 },
  blank: { name:'なし', url:null, min:0, max:0 },
};
<!--@SRC:2555-2887-->

/* ================= 計測線（2点以上を選んで距離をはかる） ================= */
const RT_UNDO_MAX = 20;
const rtUndo=[], rtRedo=[];
/* 点そのものが入れ替わる操作（取込の削除・合流・復元・全削除）のあとは、
   取消の履歴が古い世界を指しているので全部捨てる。 */
function clearUndoStacks(){
  recUndo.length=0; recRedo.length=0;
  rtUndo.length=0;  rtRedo.length=0;
}
function pushRtUndo(){
  rtUndo.push(JSON.stringify(store.routes));
  if(rtUndo.length>RT_UNDO_MAX) rtUndo.shift();
  rtRedo.length=0;
}
function undoRoute(){
  if(!rtUndo.length){ toast('取り消せる計測の操作はありません'); return; }
  rtRedo.push(JSON.stringify(store.routes));
  store.routes = JSON.parse(rtUndo.pop());
  save(); draw(); updateActionbar(); refreshEdits();
  toast('計測の操作を取り消しました');
}
function redoRoute(){
  if(!rtRedo.length){ toast('やり直せる計測の操作はありません'); return; }
  rtUndo.push(JSON.stringify(store.routes));
  store.routes = JSON.parse(rtRedo.pop());
  save(); draw(); updateActionbar(); refreshEdits();
  toast('計測の操作をやり直しました');
}
function routeLength(ids){
  const idx=ptIndex();
  let d=0;
  for(let i=0;i<ids.length-1;i++){
    const a=idx.get(ids[i]), b=idx.get(ids[i+1]);
    if(a&&b) d+=distBetween(a,b);
  }
  return d;
}
function routeLabel(r){
  const idx=ptIndex();
  return (r.ptIds||[]).map(id=>{ const p=idx.get(id); return p?displayPointName(p):'?'; }).join('－');
}
function undoRoutePt(){ state.currentRoute.pop(); updateActionbar(); draw(); }
function cancelRoute(){ state.currentRoute=[]; updateActionbar(); draw(); }
function commitRoute(){
  if(state.currentRoute.length<2){ toast('2点以上タップしてください'); return; }
  pushRtUndo();
  const rt={ id:newId(), ptIds:[...state.currentRoute], date:todayStr(), ts:Date.now() };
  store.routes.push(rt);
  state.currentRoute=[];
  store.layers.route=true; store.layers.dist=true;
  save(); updateActionbar(); draw(); refreshEdits();
  toast(`${rt.ptIds.length}点の計測線を引きました（${fmtDist(routeLength(rt.ptIds))}m）`);
}
function delRoute(id){
  const r=store.routes.find(x=>x.id===id);
  if(!r) return;
  if(!confirm(`この計測線を削除しますか?\n\n${routeLabel(r)}\n${fmtDist(routeLength(r.ptIds))}m\n\n点は残ります。［取消］で戻せます。`)) return;
  pushRtUndo();
  store.routes=store.routes.filter(x=>x.id!==id);
  save(); draw(); updateActionbar(); refreshEdits();
  toast('計測線を削除しました（［取消］で戻せます）');
}
function clearRoutes(){
  const n=store.routes.length;
  if(!n){ toast('計測線はありません'); return; }
  if(!confirm(`【削除するもの】計測線 ${n}本すべて\n【残るもの】点・画地の線・記録はすべて残ります\n【元に戻せるか】［取消］で戻せます\n\n削除しますか?`)) return;
  pushRtUndo();
  store.routes=[]; state.currentRoute=[];
  save(); draw(); updateActionbar(); refreshEdits();
  toast(`計測線 ${n}本 を削除しました（［取消］で戻せます）`);
}
function setMemoColor(c){ state.memoColor=c; state.eraser=false; updateActionbar(); }
function toggleEraser(){ state.eraser=!state.eraser; updateActionbar(); }
function undoStroke(){ store.strokes.pop(); save(); draw(); }
function clearStrokes(){
  if(!store.strokes.length){ toast('手書きメモはありません'); return; }
  if(!confirm(`【消すもの】手書きメモ ${store.strokes.length}本すべて\n【残るもの】点・線・記録は残ります\n【元に戻せるか】戻せません（自動控えからなら戻せます）\n\n消去しますか?`)) return;
  store.strokes=[]; save(); draw(); refreshEdits();
  toast('手書きメモを全て消去しました');
}

/* ================= リボン ================= */
const RIBBON = [
  { id:'prep',  label:'準備', icon:'🗺', mode:'view', groups:[
      { label:'現場', items:[
          {ic:'📁', t:'現場', fn:"openSites()", sub:'siteCount'} ]},
      { label:'背景地図', sel:'basemap' },
      { label:'取込', items:[
          {ic:'📥', t:'境界点取込', fn:"pickImport('bp')",  sub:'bpCount'},
          {ic:'📗', t:'基準点取込', fn:"pickImport('ref')", sub:'refCount'} ]},
      { label:'図面', items:[
          {ic:'🗺', t:'図面読込', fn:"pickTiff()", sub:'tiffShort'},
          {ic:'🗂', t:'図面管理', fn:"openTiffs()", sub:'tiffCount'} ]},
      { label:'表示', items:[
          {ic:'🗂', t:'レイヤ', fn:"openLayers()", sub:'layer'} ]},
      { label:'設定', items:[
          {ic:'⚙',  t:'各種設定', fn:"openSettings()", sub:'worker'},
          {ic:'🪧', t:'杭種編集', fn:"openStakes()", sub:'stakeN'} ]},
      { label:'ヘルプ', items:[
          {ic:'❓', t:'使い方', fn:"openPanel('helpPanel')"} ]},
    ]},
  { id:'rec',  label:'復元', icon:'🪧', mode:'rec', groups:[
      { label:'杭種', sel:'stake' },
      { label:'点の一覧', items:[
          {ic:'📋', t:'点一覧', fn:"openList('pt')", sub:'prog'} ]},
      { label:'点の設定', items:[
          {ic:'🎨', t:'点の表示', fn:"openDispPt()"} ]},
    ]},
  { id:'meas', label:'計測', icon:'📐', mode:'line', groups:[
      { label:'距離', items:[
          {ic:'📏', t:'距離レイヤ', fn:"toggleLayer('dist')", on:'dist', sub:'distOn'} ]},
      { label:'線の一覧', items:[
          {ic:'📋', t:'計測線一覧', fn:"openList('rt')", sub:'rtCount'} ]},
      { label:'線の設定', items:[
          {ic:'🎨', t:'線の表示', fn:"openDispLine()"},
          {ic:'🗑', t:'計測線全削除', fn:"clearRoutes()", dis:'noRoute', danger:true} ]},
    ]},
  { id:'memo', label:'メモ', icon:'✏️', mode:'memo', groups:[
      { label:'ペン', items:[
          {ic:'🔴', t:'赤', fn:"setMemoColor('#d9261c')", on:'c#d9261c'},
          {ic:'🔵', t:'青', fn:"setMemoColor('#1e73d2')", on:'c#1e73d2'},
          {ic:'⚫', t:'黒', fn:"setMemoColor('#111111')", on:'c#111111'} ]},
      { label:'消去', items:[
          {ic:'🧽', t:'消しゴム', fn:"toggleEraser()", on:'eraser'},
          {ic:'↩',  t:'1本戻す', fn:"undoStroke()"},
          {ic:'🗑', t:'メモ全消去', fn:"clearStrokes()", danger:true} ]},
    ]},
  { id:'check', label:'確認', icon:'🔍', mode:'view', groups:[
      { label:'表示', items:[
          {ic:'🗂', t:'レイヤ', fn:"openLayers()", sub:'layer'},
          {ic:'📋', t:'一覧',   fn:"openList('all')", sub:'listCount'} ]},
      { label:'データ', items:[
          {ic:'🛡', t:'保存状態', fn:"showStorageInfo()"},
          {ic:'🕘', t:'自動控え', fn:"openSnapshots()"} ]},
      { label:'点検', items:[
          {ic:'🔍', t:'TIFF情報', fn:"showTiffInfo()"},
          {ic:'🖱', t:'擬似GPS',  fn:"toggleMock()", on:'mock'},
          {ic:'🗓', t:'擬似日付', fn:"openMockDate()", on:'mockDate'} ]},
    ]},
  { id:'data', label:'データ', icon:'💾', mode:'view', groups:[
      { label:'出力', items:[
          {ic:'📄', t:'復元点CSV', fn:"exportRestorationCsv()", sub:'bpCount'} ]},
      { label:'控え', items:[
          {ic:'📤', t:'保存', fn:"exportJson()", sub:'backup'},
          {ic:'📥', t:'控えを読む', fn:"pickMerge()"},
          {ic:'🧹', t:'この現場を空に', fn:"clearSite()", danger:true},
          {ic:'🗑', t:'全現場を消す', fn:"clearAllSites()", danger:true} ]},
    ]},
];
const MODE_LABEL={view:'閲覧',rec:'復元',line:'計測',memo:'メモ'};
let ribbonTab='prep', ribbonOpen=true;
function tabDef(id){ return RIBBON.find(t=>t.id===id) || RIBBON[0]; }
function setTab(id, toggle){
  const t=tabDef(id);
  if(ribbonTab===id){
    if(toggle){ ribbonOpen=!ribbonOpen; renderRibbon(); resize(); }
    return;
  }
  if(!setMode(t.mode, id)) return;
  ribbonTab=id; ribbonOpen=true;
  closeAllPanels();
  renderRibbon(); resize();
}
function setMode(m, forTab){
  if(state.mode==='line' && m!=='line' && state.currentRoute.length){
    if(!confirm('選んでいる途中の計測は破棄されます。よろしいですか?')) return false;
    state.currentRoute=[];
  }
  state.mode=m;
  const el=document.getElementById('modeLabel');
  if(el) el.textContent = forTab ? tabDef(forTab).label : MODE_LABEL[m];
  updateActionbar(); draw(); updateWakeLock();
  return true;
}
function ribbonState(){
  const c=progCounts();
  const le=store.settings.lastExport, dz=daysSince(le);
  const bp=store.imports.filter(i=>i.kind!=='ref').length;
  const rf=store.imports.filter(i=>i.kind==='ref').length;
  return {
    dis: { noRoute: !store.routes.length,
           noRecUndo: !recUndo.length, noRecRedo: !recRedo.length,
           noRtUndo: !rtUndo.length, noRtRedo: !rtRedo.length },
    on:  { eraser: state.eraser, mock: !!store.settings.mockGps,
           mockDate: !!store.settings.mockDate,
           dist: store.layers.dist!==false,
           'c#d9261c': !state.eraser && state.memoColor==='#d9261c',
           'c#1e73d2': !state.eraser && state.memoColor==='#1e73d2',
           'c#111111': !state.eraser && state.memoColor==='#111111' },
    badge:{ route: state.currentRoute.length || '' },
    sub: {
      bpCount: c.all ? `${c.all}点/${bp}件` : '未取込',
      refCount: store.refPoints.length ? `${store.refPoints.length}点/${rf}件` : '未取込',
      tiffCount: tiffList().length ? tiffList().length+'枚' : '未読込',
      tiffShort: state.tiff
        ? (epsgToZone(state.epsg) ? epsgToZone(state.epsg)+'系' : (state.geographic ? '経緯度' : store.settings.zone+'系'))
        : '未読込',
      worker: store.settings.worker || '未設定',
      stakeN: `${stakeList().length}種`,
      prog: c.all ? `${c.done}/${c.all}点` : '0点',
      rtCount: store.routes.length + '本',
      distOn: store.layers.dist!==false ? '表示' : '非表示',
      layer: `${store.lines.length}画地/${store.imports.length}件`,
      listCount: `${c.all}点/${store.lines.length}画地`,
      backup: !c.all ? '' : (!le ? '未保存' : (dz<=0 ? '本日' : dz + '日前')),
      siteCount: `${activeSiteName()||'—'}\u3000${siteList().length}/${siteMax()}件`,
    },
    warn: { worker: !store.settings.worker,
            backup: c.done>0 && daysSince(le)>=7 },
  };
}
function renderRibbon(){
  const tabs=document.getElementById('ribbonTabs');
  tabs.innerHTML = RIBBON.map(t=>
    `<button type="button" role="tab" aria-selected="${t.id===ribbonTab}"
       class="${t.id===ribbonTab?'active':''}" onclick="setTab('${t.id}',true)">
       <span class="tic" aria-hidden="true">${t.icon}</span>${t.label}</button>`).join('');
  const cmd=document.getElementById('ribbonCmd');
  cmd.classList.toggle('hide', !ribbonOpen);
  if(!ribbonOpen){ cmd.innerHTML=''; return; }
  const st=ribbonState();
  cmd.innerHTML = tabDef(ribbonTab).groups.map(g=>{
    let inner;
    if(g.sel==='stake'){
      const opts=stakeList().map(x=>
        `<option value="${esc(x)}" ${x===currentStake()?'selected':''}>${esc(x)}</option>`).join('');
      inner=`<div class="rsel"><span>使用中</span>
        <select onchange="setStake(this.value)">${opts}</select></div>`;
    } else if(g.sel==='basemap'){
      const cur=baseMapId();
      const opts=Object.keys(GSI_TILES).map(k=>
        `<option value="${k}" ${k===cur?'selected':''}>${GSI_TILES[k].name}</option>`).join('');
      inner=`<div class="rsel"><span>国土地理院</span>
        <select onchange="setBaseMap(this.value)">${opts}</select></div>`;
    } else {
      inner=g.items.map(i=>{
        const dis=i.dis && st.dis[i.dis];
        const on =i.on  && st.on[i.on];
        const sub=i.sub ? st.sub[i.sub] : '';
        const bd =i.badge ? st.badge[i.badge] : '';
        const wrn=i.sub && st.warn[i.sub];
        return `<button type="button" class="rbtn${on?' on':''}${i.danger?' danger':''}"
          onclick="${i.fn}" ${dis?'disabled':''}>
          <span class="ic">${i.ic}</span>${i.t}
          ${sub?`<span style="font-size:var(--fsGl);color:${wrn?'#b3261e':'#7a8694'}">${esc(sub)}</span>`:''}
          ${bd?`<span class="rbadge">${bd}</span>`:''}</button>`;
      }).join('');
    }
    return `<div class="rgroup"><div class="rrow">${inner}</div>
            <div class="glabel">${g.label}</div></div>`;
  }).join('');
  cmd.scrollLeft=0;
  updateRibbonEdges();
  applyA11y(cmd); applyA11y(tabs);
}
function updateRibbonEdges(){
  const cmd=document.getElementById('ribbonCmd');
  const L=document.getElementById('redgeL'), R=document.getElementById('redgeR');
  if(!cmd||!L||!R) return;
  const more=cmd.scrollWidth-cmd.clientWidth;
  L.classList.toggle('on', ribbonOpen && cmd.scrollLeft>4);
  R.classList.toggle('on', ribbonOpen && more>4 && cmd.scrollLeft<more-4);
}
document.addEventListener('DOMContentLoaded', ()=>{
  const cmd=document.getElementById('ribbonCmd');
  if(cmd) cmd.addEventListener('scroll', updateRibbonEdges, {passive:true});
});
window.addEventListener('resize', ()=>setTimeout(updateRibbonEdges,60));
function pickTiff(){ document.getElementById('fileTiff').click(); }
function pickMerge(){ document.getElementById('fileMerge').click(); }
function sideBtn(ic,label,fn,disabled){
  return `<button type="button" class="sidebtn${disabled?' off':''}" ${disabled?'disabled':''}
    onclick="${fn}" aria-label="${label}" title="${label}">
    <span class="si">${ic}</span><span class="sl">${label}</span></button>`;
}
function updateActionbar(){
  const bar=document.getElementById('actionbar');
  if(!bar) return;
  const st=ribbonState();
  if(state.mode==='rec'){
    const c=progCounts();
    bar.innerHTML=`<div class="rowwrap">
      ${sideBtn('↩','取消','undoRec()',st.dis.noRecUndo)}
      <div id="stakeBar">${c.all?`点をタップして記録（打設 ${c.da}／既設 ${c.ki}／未 ${c.no}）`
                                 :'「準備」タブの［境界点取込］から読み込んでください'}</div>
      ${sideBtn('↪','やり直し','redoRec()',st.dis.noRecRedo)}</div>`;
  } else if(state.mode==='line'){
    const n=state.currentRoute.length;
    bar.innerHTML = n
      ? `<div class="rowwrap">
          ${sideBtn('←','戻る','undoRoutePt()',false)}
          <button type="button" class="bigbtn ok" onclick="commitRoute()">✓ ${n}点で確定${n>=2?`（${fmtDist(routeLength(state.currentRoute))}m）`:''}</button>
          ${sideBtn('✕','中止','cancelRoute()',false)}</div>`
      : `<div class="rowwrap">
          ${sideBtn('↩','取消','undoRoute()',st.dis.noRtUndo)}
          <div id="stakeBar">点をタップして距離をはかります</div>
          ${sideBtn('↪','やり直し','redoRoute()',st.dis.noRtRedo)}</div>`;
  } else bar.innerHTML='';
  if(document.getElementById('ribbonCmd')) renderRibbon();
}
<!--@SRC:2516-2540-->

/* ================= 現場の画面 ================= */
function openSites(){ renderSites(); openPanel('sitePanel'); }
function renderSites(){
  const max=siteMax(), n=siteList().length;
  document.getElementById('siteInfo').innerHTML =
    `<b>${n} / ${max}件</b>　開けるのは1つだけです。`
    + (n>=max?`<br><span style="color:#8c1d18;">上限です。新しく作るには、どれかを削除するか［各種設定］で上限を増やしてください。</span>`:'');
  const cur=sites.active;
  document.getElementById('siteRows').innerHTML = siteList().map(x=>{
    const on=x.id===cur;
    const up=x.updated?String(x.updated).slice(0,10):'';
    return `<div class="siteRow${on?' on':''}">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="flex:1;min-width:0;">
          <span class="nm">${esc(x.name)}</span>${on?'<span class="badge">開いています</span>':''}
          <span class="sub">境界点 ${x.pts||0}（記録済み ${x.done||0}）／画地 ${x.lines||0}${up?`　最終 ${up}`:''}</span>
        </span>
        ${on?'':`<button type="button" class="del" style="background:#e7f0fb;color:#1e73d2;min-width:56px;"
          onclick="openSite('${x.id}')">開く</button>`}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button type="button" class="del" style="flex:1;" onclick="askRenameSite('${x.id}')">名前を変える</button>
        <button type="button" class="del" style="flex:1;${n<=1?'opacity:.45;':''}" onclick="askRemoveSite('${x.id}')">削除</button>
      </div></div>`;
  }).join('');
  const btn=document.getElementById('newSiteBtn');
  if(btn){ btn.disabled=n>=max; btn.style.opacity=n>=max?'.45':''; }
  applyA11y(document.getElementById('sitePanel'));
}
async function openSite(id){
  await switchSite(id);
  closePanel('sitePanel');
}
async function addSite(){
  const el=document.getElementById('newSiteName');
  const rec=await createSite(el?el.value:'');
  if(!rec) return;
  if(el) el.value='';
  closePanel('sitePanel');
  toast(`現場「${rec.name}」を作りました`);
}
async function askRenameSite(id){
  const s=siteById(id); if(!s) return;
  const v=prompt('現場の名前を入れてください。', s.name);
  if(v===null) return;
  if(!String(v).trim()){ toast('名前は空にできません'); return; }
  await renameSite(id, v);
  toast('名前を変えました');
}
async function askRemoveSite(id){ await removeSite(id); }

/* ================= 杭種の設定 ================= */
function openStakes(){
  document.getElementById('stakeEdit').innerHTML = stakeList().map((s,i)=>
    `<div class="listRow">
      <input value="${esc(s)}" onchange="editStake(${i},this.value)" style="flex:1;" placeholder="杭種名">
      <button type="button" class="del" onclick="delStake(${i})">削除</button></div>`).join('');
  openPanel('stakePanel');
}
function editStake(i,v){
  const list=stakeList();
  if(!list[i]) return;
  const old=list[i]; v=String(v||'').trim();
  if(!v){ toast('杭種名は空にできません'); openStakes(); return; }
  list[i]=v;
  if(store.settings.stake===old) store.settings.stake=v;
  save(); openStakes(); updateActionbar();
}
function addStake(){ stakeList().push('新しい杭種'); save(); openStakes(); }
function delStake(i){
  const list=stakeList();
  if(list.length<=1){ toast('これ以上削除できません'); return; }
  const s=list[i];
  if(!confirm(`「${s}」を一覧から削除しますか?\n（記録済みの点の杭種はそのまま残ります）`)) return;
  list.splice(i,1);
  if(store.settings.stake===s) store.settings.stake=list[0];
  save(); openStakes(); updateActionbar();
}
function resetStakes(){
  if(!confirm('杭種の一覧を初期値に戻しますか?')) return;
  store.settings.stakes=DEFAULT_STAKES.slice();
  store.settings.stakesVer=STAKES_VERSION;
  store.settings.stake=DEFAULT_STAKES[0];
  save(); openStakes(); updateActionbar();
}

/* ================= レイヤ表示 ================= */
function openLayers(){
  document.getElementById('layerNow').innerHTML = layerNowText();
  /* 4つ目は色の設定キー。入っているレイヤは、この画面でそのまま色を変えられる。
     境界点は打設・既設・未の3色があるので、下の「記録の状態」の節で変える。 */
  const rows=[
    ['pt',   '境界点', progCounts().all+'点', null],
    ['line', '画地の線', store.lines.length+'画地', 'lineColor'],
    ['plotName', '画地名（地番）', store.lines.length?'画地ごとに1つ':'—', 'plotNameColor'],
    ['route','計測線', store.routes.length+'本', 'routeColor'],
    ['dist', '距離', store.layers.dist!==false?`辺が${Math.max(10,+store.settings.thinDist||40)}px以上のとき`:'—', 'distColor'],
    ['ref',  '基準点', store.refPoints.length+'点', 'refColor'],
    ['memo', '手書きメモ', store.strokes.length+'本', null],
    ['base', '図面（GeoTIFF）', tiffList().length?tiffList().length+'枚':'未読込', null],
    ['map',  '背景地図（地理院）', baseMapDef().name, null]
  ];
  const alpha=Math.round(tiffAlpha()*100);
  document.getElementById('otherLayers').innerHTML = rows.map(([k,lb,info,ck])=>{
    const on=store.layers[k]!==false;
    const col = ck ? `<input type="color" class="layerCol" value="${esc(disp(ck))}"
        title="${lb}の色" aria-label="${lb}の色" onchange="setDisp('${ck}',this.value)">`
      : '<span class="layerCol noCol"></span>';
    let row=`<div class="listRow">
      <button type="button" class="del" style="background:${on?'#e7f0fb':'#f0f0f0'};color:${on?'#1e73d2':'#999'};min-width:52px;"
        onclick="toggleLayer('${k}')">${on?'表示':'非表示'}</button>
      ${col}<span style="flex:1">${lb}</span><span class="coords">${esc(info)}</span></div>`;
    if(k==='map'){
      row+=`<div class="listRow" style="padding-top:0;">
        <span style="min-width:52px;"></span>
        <button type="button" class="del" style="flex:1;background:#e7f0fb;color:#1e3a5f;"
          onclick="closePanel('layerPanel');cacheViewTiles()">この範囲を圏外用に控える</button>
        <button type="button" class="del" style="flex:1;"
          onclick="closePanel('layerPanel');clearTileCache()">控えを削除</button></div>`;
    }
    if(k==='base'){
      row+=`<div class="listRow" style="padding-top:0;">
        <span style="min-width:52px;"></span>
        <span style="flex:1;font-size:13px;color:#666c74;">透過率
          <span id="tiffAlphaVal" style="color:#1e3a5f;font-weight:bold;">${alpha}%</span></span>
        <input id="tiffAlpha" type="range" min="10" max="100" step="5" value="${alpha}"
          ${tiffList().length?'':'disabled'} style="flex:1.6;"
          oninput="document.getElementById('tiffAlphaVal').textContent=this.value+'%'"
          onchange="setTiffAlpha(this.value)"></div>`;
    }
    return row;
  }).join('');
  const c=progCounts();
  const sts=[['stDa','打設',c.da,disp('stDaColor'),'stDaColor'],
             ['stKi','既設',c.ki,disp('stKiColor'),'stKiColor'],
             ['stNone','未',c.no,disp('stNoColor'),'stNoColor']];
  document.getElementById('stateLayers').innerHTML = sts.map(([k,lb,n,col,ck])=>{
    const on=store.layers[k]!==false;
    return `<div class="listRow">
      <button type="button" class="del" style="background:${on?'#e7f0fb':'#f0f0f0'};color:${on?'#1e73d2':'#999'};min-width:52px;"
        onclick="toggleLayer('${k}')">${on?'表示':'非表示'}</button>
      <input type="color" class="layerCol" value="${esc(col)}"
        title="${lb}の点の色" aria-label="${lb}の点の色" onchange="setDisp('${ck}',this.value)">
      <span style="flex:1">${lb}</span><span class="coords">${n}点</span></div>`;
  }).join('');
  const withLines = importsWithLines();
  document.getElementById('plotNameLayers').innerHTML = withLines.length ? withLines.map(imp=>{
    const on = !(store.layers.hiddenPlotNames||[]).includes(imp.id);
    const hid = !isImportVisible(imp.id);
    return `<div class="listRow">
      <button type="button" class="del" style="background:${on?'#e7f0fb':'#f0f0f0'};color:${on?'#1e73d2':'#999'};min-width:52px;"
        onclick="togglePlotNameLayer('${imp.id}')">${on?'表示':'非表示'}</button>
      <span class="layerCol" style="background:${impColor(imp.id)||disp('plotNameColor')}"
        title="この地番名の色"></span>
      <span style="flex:1">${esc(imp.name)}</span>
      <span class="coords">${linesOf(imp.id).length}画地${hid?'<br>ファイルが非表示':''}</span></div>`;
  }).join('') : '<p style="color:#888;font-size:14px;">画地データ入りのSIMAを取り込むと、ここに出ます</p>';
  document.getElementById('importLayers').innerHTML = store.imports.length ? store.imports.map(imp=>{
    const on=isImportVisible(imp.id);
    const n = imp.kind==='ref' ? refPointsOf(imp.id).length : pointsOf(imp.id).length;
    const ln= linesOf(imp.id).length;
    /* 色は画地の線と地番名にだけ効くので、画地を持つファイルにだけ出す */
    const col = ln ? `<input type="color" class="layerCol" value="${esc(impColor(imp.id)||disp('lineColor'))}"
        title="${esc(imp.name)}の線と地番名の色" aria-label="${esc(imp.name)}の線と地番名の色"
        onchange="setImpColor('${imp.id}',this.value)">` : '<span class="layerCol noCol"></span>';
    let row=`<div class="listRow">
      <button type="button" class="del" style="background:${on?'#e7f0fb':'#f0f0f0'};color:${on?'#1e73d2':'#999'};min-width:52px;"
        onclick="toggleImportLayer('${imp.id}')">${on?'表示':'非表示'}</button>
      ${col}
      <span class="stChip ${imp.kind==='ref'?'no':'da'}" style="${imp.kind==='ref'?`background:${REF_STROKE};`:''}">${imp.kind==='ref'?'基準点':'境界点'}</span>
      <span style="flex:1">${esc(imp.name)}</span>
      <span class="coords">${n}点${ln?`<br>${ln}画地`:''}</span>
      <button type="button" class="del" onclick="fitToImport('${imp.id}')" title="表示範囲へ移動">⤢</button>
      <button type="button" class="del" onclick="delImport('${imp.id}')">削除</button></div>`;
    if(ln && impColor(imp.id)) row+=`<div class="listRow" style="padding-top:0;">
      <span style="min-width:52px;"></span>
      <button type="button" class="del" style="flex:1;background:#e7f0fb;color:#1e3a5f;"
        onclick="clearImpColor('${imp.id}')">このファイルの色を「表示設定」に戻す</button></div>`;
    return row;
  }).join('') : '<p style="color:#888;font-size:14px;">まだ取り込んでいません（「準備」タブの［境界点取込］から）</p>';
  openPanel('layerPanel');
}
function toggleLayer(k){
  store.layers[k]=store.layers[k]===false;
  save(); draw(); renderRibbon();
  if(panelOpen('layerPanel')) openLayers();
  else toast(`${layerName(k)}を${store.layers[k]?'表示':'非表示'}にしました`);
}
function layerName(k){
  return {pt:'境界点',line:'画地の線',plotName:'画地名（地番）',route:'計測線',dist:'距離',ref:'基準点',
          memo:'手書きメモ',base:'図面',map:'背景地図',
          stDa:'打設',stKi:'既設',stNone:'未'}[k]||k;
}
/* 取込ファイルごとの色。線と地番名だけに効く（境界点は記録の状態の色のまま） */
function setImpColor(id, v){
  const im=importById(id); if(!im) return;
  if(!isColorHex(v)) return;
  im.color=v;
  save(); draw();
  if(panelOpen('layerPanel')) openLayers();
}
function clearImpColor(id){
  const im=importById(id); if(!im) return;
  delete im.color;
  save(); draw();
  if(panelOpen('layerPanel')) openLayers();
  toast(`${im.name}の色を「表示設定」に戻しました`);
}
function togglePlotNameLayer(id){
  const h=store.layers.hiddenPlotNames||(store.layers.hiddenPlotNames=[]);
  const i=h.indexOf(id);
  if(i>=0) h.splice(i,1); else h.push(id);
  save(); openLayers(); draw();
}
function toggleImportLayer(id){
  const h=store.layers.hiddenImports||(store.layers.hiddenImports=[]);
  const i=h.indexOf(id);
  if(i>=0) h.splice(i,1); else h.push(id);
  save(); openLayers(); draw();
}
function showAllLayers(){
  store.layers.hiddenImports=[];
  store.layers.hiddenPlotNames=[];
  ['pt','ref','line','plotName','route','dist','memo','base','map','stNone','stDa','stKi']
    .forEach(k=>store.layers[k]=true);
  save(); openLayers(); draw(); renderRibbon();
  toast('すべて表示にしました');
}
function layerNowText(){
  const kinds=['pt','ref','line','plotName','route','dist','memo','base','map'];
  const off=kinds.filter(k=>store.layers[k]===false).length + (store.layers.hiddenImports||[]).length;
  const stOff=['stDa','stKi','stNone'].filter(k=>store.layers[k]===false).map(layerName);
  const pn=(store.layers.hiddenPlotNames||[]).filter(i=>importById(i)).length;
  return `種類: <b>${off?`${off}種類が非表示`:'すべて'}</b>　／　状態: <b>${stOff.length?`${stOff.join('・')}を非表示`:'すべて'}</b>`
       + (pn?`　／　地番名: <b>${pn}件を非表示</b>`:'');
}

/* ================= 記録画面（点をタップしたとき） ================= */
let recPickId=null, recPickKind=null, recPickStake=null;
function openRec(id){
  const p=ptById(id);
  if(!p || p.ref){ toast('点が見つかりません'); return; }
  recPickId=id;
  recPickKind = stOf(p)==='no' ? null : stOf(p);
  recPickStake = recStake(p) || currentStake();
  renderRec(); openPanel('recPanel');
}
function recPickSetStake(v){
  recPickStake=v;
  store.settings.stake=v;          // 次にタップした点にも引き継ぐ
  save(); updateActionbar();
}
function renderRec(){
  const p=ptById(recPickId);
  if(!p){ closePanel('recPanel'); recPickId=null; return; }
  const [X,Y]=pointToXY(p);
  const cur=stOf(p);
  const plot=plotNameOf(p);
  document.getElementById('recTitle').textContent = displayPointName(p);
  /* 杭種を先に選び、［打設］［既設］を押した時点で記録して閉じる。
     現場では何百点も入れるので、押す回数を「点 → 打設」の2回で済ませる。 */
  document.getElementById('recBody').innerHTML = `
    <p style="font-size:12.5px;color:#666c74;margin:0 0 10px;">
      <span class="stChip ${cur}">${ST_NAME[cur]}</span>
      ${plot?`　画地: ${esc(plot)}`:''}<br>
      X:${X.toFixed(3)}　Y:${Y.toFixed(3)}
      ${cur!=='no'?`<br>記録: ${dateLabel(recDate(p))}${recWorker(p)?`　${esc(recWorker(p))}`:''}${recStake(p)?`　${esc(recStake(p))}`:''}`:''}</p>
    <div class="formRow"><label>杭種</label>
      <select onchange="recPickSetStake(this.value)">
        ${stakeList().map(s=>`<option value="${esc(s)}" ${s===recPickStake?'selected':''}>${esc(s)}</option>`).join('')}
      </select></div>
    <p style="font-size:12.5px;color:#888;margin:-4px 0 10px;">${cur==='no'?'下のボタンを押すと<b>その場で記録して閉じます</b>。':'押し直すと<b>記録を上書き</b>します。'}杭種は次にタップした点にも引き継がれます。</p>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button type="button" class="recBtn da${cur==='da'?' sel':''}" onclick="recCommit('da')">打設<br>
        <span style="font-weight:normal;font-size:12px;">現地に無く復元した</span></button>
      <button type="button" class="recBtn ki${cur==='ki'?' sel':''}" onclick="recCommit('ki')">既設<br>
        <span style="font-weight:normal;font-size:12px;">現地に杭があった</span></button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${cur!=='no'?`<button type="button" class="saveBtn" style="margin:0;background:#fdecea;color:#8c1d18;"
        onclick="recCancel()">この点の記録を取り消す</button>`:''}
      <button type="button" class="saveBtn" style="margin:0;background:#eee;color:#333;"
        onclick="closePanel('recPanel')">閉じる</button>
    </div>
    <p style="font-size:12.5px;color:#888;margin:10px 0 0;">間違えたら大ボタンの左の<b>［取消］</b>で戻せます。</p>`;
  applyA11y(document.getElementById('recPanel'));
}
function recCommit(k){
  const kind = k || recPickKind;
  if(kind!=='da' && kind!=='ki'){ toast('［打設］か［既設］を押してください'); return; }
  recPickKind = kind;
  const id=recPickId;
  store.settings.stake = recPickStake || currentStake();
  setRec(id, kind, store.settings.stake);
  closePanel('recPanel');
}
function recCancel(){
  const id=recPickId;
  const p=ptById(id);
  if(!p) return;
  if(!confirm(`${displayPointName(p)} の記録を取り消しますか?\n\n${ST_NAME[stOf(p)]}　${dateLabel(recDate(p))}`
    + `${recWorker(p)?`\n記録者: ${recWorker(p)}`:''}`)) return;
  clearRec(id);
  closePanel('recPanel');
}
/* 一覧・記録画面のうち開いている方だけを描き替える */
function refreshEdits(){
  if(panelOpen('listPanel')) openList();
  if(panelOpen('recPanel')) renderRec();
  if(panelOpen('layerPanel')) openLayers();
}

/* ================= 一覧 ================= */
let ptSearch='', ptSort='name', ptGroup='st', ptLimit=200;
let ptOpen=new Set();
const PT_PAGE=200;
let listKind='all';
function setPtSearch(v){ ptSearch=String(v||''); ptLimit=PT_PAGE;
  const el=document.getElementById('ptSearch'); if(el && el.value!==ptSearch) el.value=ptSearch;
  openList(); }
function setPtSort(v){ ptSort=v; ptLimit=PT_PAGE; openList(); }
function setPtGroup(v){ ptGroup=v; ptLimit=PT_PAGE; ptOpen=new Set(); openList(); }
function ptShowMore(){ ptLimit+=PT_PAGE; openList(); }
/* まとまりの見出しは、キーの文字（点名・杭種・ファイル名に由来）を onclick に埋めると
   ' や " が入ったときに壊れて開けなくなる。並び順の番号で受け渡す。 */
let ptGroupKeysNow=[];
function togglePtGroup(k){ if(ptOpen.has(k)) ptOpen.delete(k); else ptOpen.add(k); openList(); }
function togglePtGroupAt(i){
  const k=ptGroupKeysNow[i];
  if(k!==undefined) togglePtGroup(k);
}
function ptGroupIsOpen(k){ return ptSearch.trim() ? true : ptOpen.has(k); }
function ptOpenAll(){ ptOpen=new Set(store.points.filter(ptMatch).map(ptGroupKey)); openList(); }
function ptCloseAll(){ ptOpen=new Set(); openList(); }
function ptMatch(p){
  const q=ptSearch.trim().toLowerCase();
  if(!q) return true;
  return String(p.name||'').toLowerCase().includes(q)
      || String(recStake(p)).toLowerCase().includes(q)
      || String(recWorker(p)).toLowerCase().includes(q)
      || String(plotNameOf(p)).toLowerCase().includes(q)
      || ST_NAME[stOf(p)].includes(q);
}
function ptGroupKey(p){
  if(ptGroup==='plot')  return plotNameOf(p) || '画地なし';
  if(ptGroup==='stake') return recStake(p) || '未記録';
  if(ptGroup==='date')  return recDate(p) || '未記録';
  if(ptGroup==='imp'){ const i=importById(p.impId); return i?i.name:'—'; }
  if(ptGroup==='none')  return '';
  return ST_NAME[stOf(p)];
}
function ptGroupLabel(k){
  if(ptGroup==='date') return k==='未記録' ? '未記録' : dateLabel(k);
  return k;
}
function ptSorted(list){
  const a=list.slice();
  if(ptSort==='name')      a.sort((x,y)=>String(x.name).localeCompare(String(y.name),'ja',{numeric:true}));
  else if(ptSort==='nameDesc') a.sort((x,y)=>String(y.name).localeCompare(String(x.name),'ja',{numeric:true}));
  else if(ptSort==='recNew')   a.sort((x,y)=>((y.rec&&y.rec.t)||0)-((x.rec&&x.rec.t)||0));
  else a.sort((x,y)=>(x.idx||0)-(y.idx||0));
  return a;
}
function openList(kind){
  if(kind) listKind=kind;
  const show=(id,on)=>{ const e=document.getElementById(id); if(e) e.style.display=on?'block':'none'; };
  show('secPt',  listKind!=='rt');
  show('secRt',  listKind==='all' || listKind==='rt');
  show('secOther', listKind==='all');
  const ttl=document.getElementById('listTitle');
  if(ttl) ttl.textContent = listKind==='pt' ? '境界点一覧' : listKind==='rt' ? '計測線一覧' : '一覧';
  const sel=(id,v)=>{ const e=document.getElementById(id); if(e) e.value=v; };
  sel('ptSort',ptSort); sel('ptGroup',ptGroup);
  const se=document.getElementById('ptSearch'); if(se && se.value!==ptSearch) se.value=ptSearch;

  const c=progCounts();
  const pi=document.getElementById('progInfo');
  if(pi) pi.innerHTML = c.all
    ? `<b>${c.all}点中 ${c.done}点を記録しました</b>（${c.all?Math.round(c.done/c.all*100):0}%）<br>`
      + `<span class="stChip da">打設 ${c.da}</span> <span class="stChip ki">既設 ${c.ki}</span> <span class="stChip no">未 ${c.no}</span>`
    : '境界点を取り込んでいません（「準備」タブの［境界点取込］から）';

  const hit=ptSorted(store.points.filter(ptMatch));
  const grouped = ptGroup!=='none';
  const shown = grouped ? hit : hit.slice(0, ptLimit);
  const info=document.getElementById('ptListInfo');
  if(info) info.textContent = `${store.points.length}点中 ${hit.length}点`
    + (grouped ? 'をまとめて表示' : 'を表示')
    + (!grouped && hit.length>shown.length ? `（先頭${shown.length}点）` : '')
    + (ptSearch.trim()?`　検索: 「${ptSearch.trim()}」`:'');
  const more=document.getElementById('ptMoreBox');
  if(more) more.style.display = (!grouped && hit.length>shown.length) ? 'block' : 'none';

  const row = p=>{
    const [X,Y]=pointToXY(p);
    const k=stOf(p), plot=plotNameOf(p);
    return `<div class="listRow">
      <span class="swatch" style="background:${k==='no'?'#fff':stColor(k)};border-color:${stColor(k)};"></span>
      <span style="flex:1;min-width:0;">
        <b>${esc(displayPointName(p))}</b> <span class="stChip ${k}">${ST_NAME[k]}</span>
        <span class="coords" style="display:block;">X:${X.toFixed(3)}　Y:${Y.toFixed(3)}</span>
        ${plot?`<span class="coords" style="display:block;">${esc(plot)}</span>`:''}
        ${k!=='no'?`<span class="coords" style="display:block;">${dateLabel(recDate(p))}　${esc(recStake(p))}${recWorker(p)?`　${esc(recWorker(p))}`:''}</span>`:''}</span>
      <button type="button" class="del" style="background:#eef2f7;color:#1e3a5f;min-width:52px;"
        onclick="closePanel('listPanel');fitToPoint('${p.id}')" title="この点へ移動">⤢</button>
      <button type="button" class="del" style="background:#eef2f7;color:#1e3a5f;min-width:52px;"
        onclick="openRec('${p.id}')">記録</button></div>`;
  };
  let html='';
  if(!shown.length){
    html=`<p style="color:#888;font-size:14px;">${store.points.length?'条件に合う点がありません':'境界点がありません'}</p>`;
  } else if(!grouped){
    html=shown.map(row).join('');
  } else {
    /* まとまりは「条件に合う全部」から作る（先頭200点だけで区切ると、
       他のまとまりが画面から消えてしまい「打設したはずの点が無い」と見えるため）。
       たたんである間は中身を作らないので、数千点あっても重くならない。 */
    const keys=[]; const bag={};
    for(const p of shown){ const k=ptGroupKey(p); if(!(k in bag)){ bag[k]=[]; keys.push(k); } bag[k].push(p); }
    if(ptGroup==='date') keys.sort().reverse();
    if(ptGroup==='st'){
      const order=['打設','既設','未'];
      keys.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
    }
    ptGroupKeysNow=keys.slice();
    html=keys.map(k=>{
      const op=ptGroupIsOpen(k);
      const list=bag[k], cut=list.slice(0, PT_PAGE);
      return `<button type="button" onclick="togglePtGroupAt(${keys.indexOf(k)})"
        style="display:flex;width:100%;align-items:center;gap:6px;margin:8px 0 2px;padding:6px 2px;
          font-size:13px;font-weight:bold;background:none;border:none;border-bottom:1px solid #ddd;color:#666c74;">
        <span style="font-size:11px;">${op?'▼':'▶'}</span>
        <span style="flex:1;text-align:left;">${esc(ptGroupLabel(k))}</span>
        <span style="font-weight:normal;">${list.length}点</span></button>`
        + (op ? cut.map(row).join('')
                + (list.length>cut.length
                   ? `<p style="font-size:12.5px;color:#888;margin:4px 0 8px;">先頭${cut.length}点を出しています（${list.length}点中）。絞り込むと残りが見えます。</p>`
                   : '')
              : '');
    }).join('');
  }
  document.getElementById('pointList').innerHTML=html;

  document.getElementById('routeList').innerHTML = store.routes.length
    ? store.routes.map(r=>
      `<div class="listRow">
        <span style="flex:1;min-width:0;">
          <b>${fmtDist(routeLength(r.ptIds))} m</b>
          <span class="coords" style="display:block;white-space:normal;">${esc(routeLabel(r))}</span>
          <span class="coords" style="display:block;">${dateLabel(r.date)}　${r.ptIds.length}点</span></span>
        <button type="button" class="del" onclick="delRoute('${r.id}')">削除</button></div>`).join('')
    : '<p style="color:#888;font-size:14px;">計測線がありません（「計測」タブで点をタップ）</p>';

  document.getElementById('lineList').innerHTML = store.lines.length
    ? store.lines.map(l=>{
      const s=lineSegments(l);
      const nv=(l.ptIds||[]).filter(Boolean).length;
      return `<div class="listRow">
        <span class="swatch" style="background:${lineColorOf(l)}"></span>
        <span style="flex:1;min-width:0;"><b>${esc(l.name||('画地'+l.no))}</b>
          <span class="coords" style="display:block;">${nv}頂点　${s.n}辺　${l.closed?'閉じた線':'開いた線'}　延長 ${fmtDist(s.total)}m</span>
          ${l.lost?`<span class="coords" style="display:block;color:#b3261e;">座標が無い頂点 ${l.lost}件（その前後の辺は引いていません）</span>`:''}</span>
        <button type="button" class="del" onclick="closePanel('listPanel');fitToLine('${l.id}')" title="この画地へ移動">⤢</button></div>`;
    }).join('')
    : '<p style="color:#888;font-size:14px;">画地の線がありません（画地データ入りのSIMAを取り込むと出ます）</p>';

  document.getElementById('importList').innerHTML = store.imports.length
    ? store.imports.map(imp=>{
      const n = imp.kind==='ref' ? refPointsOf(imp.id).length : pointsOf(imp.id).length;
      return `<div class="listRow">
        <span class="stChip ${imp.kind==='ref'?'no':'da'}" style="${imp.kind==='ref'?`background:${REF_STROKE};`:''}">${imp.kind==='ref'?'基準点':'境界点'}</span>
        <span style="flex:1"><b>${esc(imp.name)}</b>
          <span class="coords" style="display:block;">${imp.src==='sima'?'SIMA':'CSV'}　${n}点　${linesOf(imp.id).length}画地</span></span>
        <button type="button" class="del" onclick="delImport('${imp.id}')">削除</button></div>`;
    }).join('')
    : '<p style="color:#888;font-size:14px;">取り込んだファイルはありません</p>';

  const set=(id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('ptCount', store.points.length);
  set('rtCount', store.routes.length);
  set('lnCount', store.lines.length);
  set('refCount', store.refPoints.length);
  set('strokeCount', `${store.strokes.length} 本の線`);
  openPanel('listPanel');
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fitToPoint(id){
  const p=ptById(id); if(!p) return;
  state.view.cx=p.x; state.view.cy=p.y;
  state.view.scale=clampScale(Math.max(state.view.scale, 20));
  state.follow=false; updateFollowBtn(); draw();
  toast(`${displayPointName(p)} へ移動しました`);
}
function fitToBox(xs,ys){
  if(!xs.length) return;
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  state.view.cx=(x0+x1)/2; state.view.cy=(y0+y1)/2;
  const w=Math.max(x1-x0,20), h=Math.max(y1-y0,20);
  state.view.scale=clampScale(Math.min(W/w, H/h)*0.85);
  state.follow=false; updateFollowBtn(); draw();
}
function fitToLine(id){
  const l=store.lines.find(x=>x.id===id); if(!l) return;
  const idx=ptIndex();
  const pts=l.ptIds.map(i=>idx.get(i)).filter(Boolean);
  fitToBox(pts.map(p=>p.x), pts.map(p=>p.y));
  toast(`${l.name||('画地'+l.no)} へ移動しました`);
}
function fitToImport(id){
  const imp=importById(id);
  const pts = imp && imp.kind==='ref' ? refPointsOf(id) : pointsOf(id);
  if(!pts.length){ draw(); return; }
  fitToBox(pts.map(p=>p.x), pts.map(p=>p.y));
}
function updateListCount(){
  updateProg();
  if(document.getElementById('ribbonCmd')) renderRibbon();
}

/* ================= 図面（GeoTIFF）の管理 ================= */
<!--@SRC:3898-3962-->

/* ================= 画面の表示設定 ================= */
const DISP_SET = {
  pt: { title:'表示設定（点）', keys:[
    ['col',  'stDaColor',   '打設した点の色'],
    ['col',  'stKiColor',   '既設だった点の色'],
    ['col',  'stNoColor',   'まだの点の色'],
    ['size', 'ptMarkSize',  '点の大きさ'],
    ['size', 'ptNameSize',  '点名の大きさ'],
    ['col',  'refColor',    '基準点の色'],
    ['size', 'refMarkSize', '基準点の大きさ'],
    ['size', 'refNameSize', '基準点の点名の大きさ'] ] },
  line: { title:'表示設定（線・距離）', keys:[
    ['col',  'lineColor',   '画地の線の色'],
    ['num',  'lineWidth',   '画地の線の太さ', 1, 8],
    ['col',  'plotNameColor','画地名（地番）の色'],
    ['size', 'plotNameSize', '画地名（地番）の大きさ'],
    ['col',  'routeColor',  '計測線の色'],
    ['num',  'routeWidth',  '計測線の太さ', 1, 8],
    ['col',  'distColor',   '距離の文字の色'],
    ['size', 'distSize',    '距離の文字の大きさ'] ] },
};
let dispKind='pt';
function openDispPt(){   dispKind='pt';   renderDisp(); openPanel('dispPanel'); }
function openDispLine(){ dispKind='line'; renderDisp(); openPanel('dispPanel'); }
function renderDisp(){
  const def=DISP_SET[dispKind] || DISP_SET.pt;
  document.getElementById('dispTitle').textContent=def.title;
  document.getElementById('dispRows').innerHTML = def.keys.map(([t,k,lb,mn,mx])=>{
    if(t==='col') return `<div class="formRow"><label>${lb}</label>
      <input type="color" value="${esc(disp(k))}" onchange="setDisp('${k}',this.value)"
        style="flex:none;width:64px;height:40px;padding:2px;"></div>`;
    if(t==='num') return `<div class="formRow"><label>${lb}</label>
      <input type="number" min="${mn}" max="${mx}" step="1" value="${+disp(k)}"
        onchange="setDisp('${k}',this.value)"><span style="color:#888;font-size:13px;">px</span></div>`;
    return `<div class="formRow"><label>${lb}</label><select onchange="setDisp('${k}',this.value)">`
      + Object.keys(SIZE_NAMES).map(v=>
        `<option value="${v}" ${disp(k)===v?'selected':''}>${SIZE_NAMES[v]}</option>`).join('')
      + `</select></div>`;
  }).join('');
  applyA11y(document.getElementById('dispPanel'));
}
function setDisp(k,v){
  if(!store.disp) store.disp={};
  if(k==='routeWidth'||k==='lineWidth'){ const n=parseInt(v,10); v=Math.min(8,Math.max(1,isFinite(n)?n:2)); }
  store.disp[k]=v;
  save(); draw(); renderDisp();
  /* レイヤ画面からも色を変えられるので、開いていれば見た目をそろえる */
  if(panelOpen('layerPanel')) openLayers();
}
function resetDisp(){
  const def=DISP_SET[dispKind] || DISP_SET.pt;
  if(!store.disp) store.disp={};
  def.keys.forEach(([,k])=>{ store.disp[k]=DEFAULT_DISP[k]; });
  save(); draw(); renderDisp(); toast(`${def.title}を初期値に戻しました`);
}

/* ================= 設定 ================= */
const FONT_SCALES=['m','l','xl'];
function fontScale(){
  const v=store.settings.fontScale;
  return FONT_SCALES.includes(v)?v:'m';
}
function applyFontScale(){
  const v=fontScale();
  if(v==='m') document.documentElement.removeAttribute('data-fs');
  else document.documentElement.setAttribute('data-fs',v);
  if(typeof updateRibbonEdges==='function') setTimeout(updateRibbonEdges,0);
  if(typeof resize==='function') setTimeout(resize,0);
}
function openSettings(){
  document.getElementById('setFontScale').value=fontScale();
  document.getElementById('setWorker').value=store.settings.worker||'';
  document.getElementById('setSiteMax').value=siteMax();
  document.getElementById('setSiteMax').min=Math.max(SITE_MAX_MIN, siteList().length);
  document.getElementById('setThinPt').value=+store.settings.thinPt||300;
  document.getElementById('setThinName').value=+store.settings.thinName||150;
  document.getElementById('setThinDist').value=+store.settings.thinDist||40;
  const sel=document.getElementById('setZone');
  sel.innerHTML=ZONES.map((z,i)=>`<option value="${i+1}" ${store.settings.zone===i+1?'selected':''}>第${i+1}系</option>`).join('');
  openPanel('settingsPanel');
}
function saveSettings(){
  store.settings.fontScale=document.getElementById('setFontScale').value;
  applyFontScale();
  store.settings.worker=document.getElementById('setWorker').value.trim();
  const num=(id,dv,lo,hi)=>{
    const n=parseInt(document.getElementById(id).value,10);
    return isFinite(n) ? Math.min(hi,Math.max(lo,n)) : dv;
  };
  const wantMax = num('setSiteMax', SITE_MAX_DEFAULT, SITE_MAX_MIN, SITE_MAX_HI);
  const lowest  = Math.max(SITE_MAX_MIN, siteList().length);
  if(wantMax < lowest){
    toast(`現場の上限は${lowest}件より小さくできません（いま${siteList().length}件あります）`);
    store.settings.siteMax = lowest;
  } else store.settings.siteMax = wantMax;
  store.settings.thinPt   = num('setThinPt',300,20,5000);
  store.settings.thinName = num('setThinName',150,10,5000);
  store.settings.thinDist = num('setThinDist',40,10,400);
  const zSel=parseInt(document.getElementById('setZone').value)||1;
  if(zSel!==store.settings.zone) changeZone(zSel, true);
  if(state.gps.ok){ try{ const [x,y]=gpsToMap(state.gps.lon,state.gps.lat); state.gps.x=x; state.gps.y=y; }catch(e){} }
  save(); closePanel('settingsPanel'); updateActionbar(); draw();
  toast('設定を保存しました');
}

/* ================= SIMA / CSV の取込 ================= */
<!--@SRC:4331-4355-->
/* SIMAを座標データと画地データの両方で読む。
     A01,点番号,点名,X(北),Y(東),Z,          … 座標
     D00,区画番号,区画名,…                    … 画地の始まり
     B01,点番号,点名,                          … 画地の構成点
     C03,辺長,方向角(度.分秒),                 … その点から次の点まで
     D99,                                      … 画地の終わり
   C03の辺長は座標から計算した値と一致するので、そのまま距離として使う。 */
function parseSimaFull(text){
  const pts=[], plots=[];
  let cur=null, lastV=null;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();
    if(!line) continue;
    const f=splitCsvLine(line);
    const t=(f[0]||'').toUpperCase();
    if(t==='A01'){
      const X=parseFloat(f[3]), Y=parseFloat(f[4]), Z=parseFloat(f[5]);
      if(!isFinite(X)||!isFinite(Y)) continue;
      const no=(f[1]||'').trim();
      pts.push({ no, name:(f[2]||'').trim()||no||String(pts.length+1),
                 X, Y, z:isFinite(Z)?Z:0, stake:'' });
    } else if(t==='D00'){
      cur={ no:(f[1]||'').trim(), name:(f[2]||'').trim(), verts:[] };
      plots.push(cur); lastV=null;
    } else if(t==='B01' && cur){
      lastV={ no:(f[1]||'').trim(), name:(f[2]||'').trim(), d:null };
      cur.verts.push(lastV);
    } else if(t==='C03' && lastV){
      const d=parseFloat(f[1]);
      lastV.d = isFinite(d) ? d : null;
    } else if(t==='D99'){ cur=null; lastV=null; }
  }
  return { pts, plots:plots.filter(p=>p.verts.length>=2) };
}
/* CSV: 旧6列（点名,X,Y,Z,属性,杭種）と、境界復元アプリ出力の10列に対応 */
function parseCsvText(text){
  const pts=[];
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/^﻿/,'').trim();
    if(!line) continue;
    const f=splitCsvLine(line);
    if(f.length<3) continue;
    const extended=f.length>=10;
    const X=parseFloat(f[extended?2:1]), Y=parseFloat(f[extended?3:2]);
    if(!isFinite(X)||!isFinite(Y)) continue;
    const Z=parseFloat(f[extended?4:3]);
    const no=extended?(f[0]||'').trim():String(pts.length+1);
    const name=(f[extended?1:0]||'').trim()||no||String(pts.length+1);
    pts.push({ no, name, X, Y, z:isFinite(Z)?Z:0,
               stake:normalizeStakeName((f[extended?6:5]||'').trim()) });
  }
  return { pts, plots:[] };
}
/* SIMAかCSVかの判定。
   CSVの1列目は点名なので、点名が "A01" の点が1つでもあると
   「行頭が A01」という判定では誤ってSIMAとして読んでしまう（座標がずれた点が黙って入る）。
   そこで、点名になり得ない**構造の行**（G00/Z00/Z01/A00/A99/D00/D99）だけを見る。
   本物のSIMAは必ず先頭に G00 か Z00 か A00 があるので、先頭40行に限って探す。 */
function looksSima(text){
  const lines=text.split(/\r?\n/);
  let seen=0;
  for(const raw of lines){
    const line=raw.replace(/^﻿/,'').trim();
    if(!line) continue;
    /* 「コードだけの行」「ヘッダ行」など、CSVの点名では作れない形だけを見る */
    if(/^(A00|A99|D99)\s*,?\s*$/i.test(line)) return true;   // A00, / A99, / D99,
    if(/^Z01\s*,\s*\d+\s*,?\s*$/i.test(line)) return true;   // Z01,2,
    if(/^G00\s*,\s*\d{1,2}\s*,/i.test(line))  return true;   // G00,04,現場名,
    if(/^Z00\s*,[^,]*\/\*/.test(line))        return true;   // Z00, /* 座標データ */,
    if(++seen>=40) break;
  }
  return false;
}
let pendingImport=null, importKind='bp';
function pickImport(kind){
  importKind = (kind==='ref') ? 'ref' : 'bp';
  document.getElementById('fileImport').click();
}
function setImportKind(k){
  importKind = (k==='ref') ? 'ref' : 'bp';
  renderImportKind();
}
function renderImportKind(){
  document.querySelectorAll('#impKindSeg .seg').forEach(b=>
    b.classList.toggle('on', b.dataset.kind===importKind));
  const n=document.getElementById('impKindNote');
  const plots = pendingImport && pendingImport.parsed ? pendingImport.parsed.plots.length : 0;
  if(n) n.innerHTML = importKind==='ref'
    ? '<b>基準点</b>として取り込みます。蛍光緑で表示され、<b>打設・既設の記録はできません</b>（復元の対象ではないため）。計測線の相手には選べます。'
      + (plots?`<br><span style="color:#b3261e;">※このファイルの画地（線）${plots}件は入りません。線も入れたいときは［境界点］で取り込んでください。</span>`:'')
    : '<b>境界点</b>として取り込みます。地図でタップして<b>打設・既設を記録</b>できます。'
      + (plots?`画地の線 ${plots}件もいっしょに入ります。`:'このファイルに画地データはありません。');
}
document.getElementById('fileImport').addEventListener('change', async e=>{
  const file=e.target.files[0]; if(!file) return;
  e.target.value='';
  try{
    const text=decodeText(await file.arrayBuffer());
    const isSima=looksSima(text);
    const parsed=isSima?parseSimaFull(text):parseCsvText(text);
    if(!parsed.pts.length){
      alert('座標を読み取れませんでした。\n\nSIMAは A01 行、CSVは「点名, X(北), Y(東), Z, 属性, 杭種」の並びを想定しています。\nファイル: '+file.name);
      return;
    }
    pendingImport={ file, parsed, src:isSima?'sima':'csv' };
    showImportPreview();
  }catch(err){ alert('取込に失敗しました: '+(err&&err.message||err)); }
});
function showImportPreview(){
  const {file, parsed, src}=pendingImport;
  const rows=parsed.pts;
  const xs=rows.map(r=>r.Y), ys=rows.map(r=>r.X);
  const rng=a=>`${Math.min(...a).toFixed(1)} 〜 ${Math.max(...a).toFixed(1)}`;
  const plotLine = parsed.plots.length
    ? `画地（線）: <b>${parsed.plots.length}件</b>　${parsed.plots.reduce((a,p)=>a+p.verts.length,0)}辺<br>`
      + `<span style="font-size:12px;color:#6b5320;">${parsed.plots.slice(0,4).map(p=>esc(p.name||('画地'+p.no))+`（${p.verts.length}）`).join('、')}`
      + `${parsed.plots.length>4?` ほか${parsed.plots.length-4}件`:''}</span><br>`
    : '';
  let warn='';
  const t=state.tiff;
  if(t && !state.geographic){
    const inside=rows.filter(r=>r.Y>=t.bbox[0]&&r.Y<=t.bbox[2]&&r.X>=t.bbox[1]&&r.X<=t.bbox[3]).length;
    if(inside===0) warn=`<div class="noteBox" style="background:#fdecea;border-color:#f0b7b1;color:#8c1d18;">
      ⚠ 読み込んだ座標が、開いている図面の範囲から完全に外れています。<br>
      系番号の違い、またはX（北）とY（東）の並びが逆の可能性があります。</div>`;
  }
  document.getElementById('importPreview').innerHTML =
    `<div class="noteBox">ファイル: <b>${esc(file.name)}</b>（${src==='sima'?'SIMA形式':'CSV形式'}）<br>
      点: <b>${rows.length}点</b><br>${plotLine}
      X（北）: ${rng(ys)}<br>Y（東）: ${rng(xs)}<br>
      いまの座標系: <b>第${store.settings.zone}系</b></div>` + warn;
  document.getElementById('impName').value = file.name.replace(/\.[^.]+$/,'').slice(0,30);
  renderImportKind();
  openPanel('importPanel');
}
function commitImport(){
  if(!pendingImport) return;
  const {parsed, src}=pendingImport;
  const kind=importKind;
  const name=(document.getElementById('impName').value||'').trim()||(kind==='ref'?'基準点':'境界点');
  const imp={ id:newId(), name, src, kind, ts:new Date().toISOString() };
  store.imports.push(imp);
  const byNo=new Map(), byName=new Map();
  const target = kind==='ref' ? store.refPoints : store.points;
  parsed.pts.forEach((r,i)=>{
    const m=xyToMapPoint(r.X, r.Y);
    const p={ id:newId(), impId:imp.id, no:r.no, name:r.name, x:m.x, y:m.y, z:r.z||0, idx:i };
    if(r.stake) p.stake=normalizeStakeName(r.stake);
    if(kind==='ref') p.ref=true;
    target.push(p);
    if(r.no && !byNo.has(r.no)) byNo.set(r.no, p.id);
    if(!byName.has(r.name)) byName.set(r.name, p.id);
  });
  /* 画地の線は境界点として取り込んだときだけ入れる（基準点は参考なので線を持たない） */
  let nLine=0, nSeg=0, miss=0;
  const idx=new Map(target.map(p=>[p.id,p]));
  for(const pl of (kind==='ref' ? [] : parsed.plots)){
    /* 座標が見つからない頂点は **null を入れて位置をそろえる**。
       詰めてしまうと dists[i] が別の辺のラベルになり、
       元データと違う距離が黙って地図に出てしまう。null の辺は描かない。 */
    const ptIds=[], dists=[];
    let lost=0;
    for(const v of pl.verts){
      const id = byNo.get(v.no) || byName.get(v.name) || null;
      if(!id){ miss++; lost++; }
      ptIds.push(id); dists.push(v.d);
    }
    if(ptIds.filter(Boolean).length<2) continue;
    /* 最後の辺長が「末尾→先頭」と合えば閉じた線として扱う（画地はふつう閉じている） */
    const a=idx.get(ptIds[ptIds.length-1]), b=idx.get(ptIds[0]);
    const last=dists[dists.length-1];
    const closed = !!(a && b && isFinite(last) && Math.abs(distBetween(a,b)-last) < 0.05);
    store.lines.push({ id:newId(), impId:imp.id, no:pl.no, name:pl.name, ptIds, dists, closed, lost });
    nLine++; nSeg += lineSegments(store.lines[store.lines.length-1], idx).n;
  }
  store.layers.hiddenImports=(store.layers.hiddenImports||[]).filter(i=>i!==imp.id);
  pendingImport=null;
  invalidatePtMap(); invalidatePlotMap();
  save(); closePanel('importPanel'); updateListCount();
  if(!state.tiff) fitToImport(imp.id); else draw();
  toast(`「${name}」を ${parsed.pts.length}点`
    + (nLine?`／${nLine}画地 ${nSeg}辺`:'') + ' 取り込みました'
    + (miss?`（${miss}辺は点が見つからず飛ばしました）`:''));
}
function delImport(id){
  const imp=importById(id);
  if(!imp) return;
  const isRef = imp.kind==='ref';
  const pts = isRef ? refPointsOf(id) : pointsOf(id);
  const done = isRef ? 0 : pts.filter(p=>stOf(p)!=='no').length;
  const lns = linesOf(id).length;
  if(!confirm(`【削除するもの】「${imp.name}」の ${pts.length}点`
    + (lns?`と ${lns}画地の線`:'')
    + (done?`\n　※このうち ${done}点は打設・既設の記録が入っています。記録もいっしょに消えます`:'')
    + `\n【残るもの】ほかのファイルの点・線・記録\n【元に戻せるか】戻せません（自動控えからなら戻せます）\n\n削除しますか?`)) return;
  const ids=new Set(pts.map(p=>p.id));
  if(isRef) store.refPoints=store.refPoints.filter(p=>p.impId!==id);
  else      store.points=store.points.filter(p=>p.impId!==id);
  store.lines=store.lines.filter(l=>l.impId!==id);
  store.routes.forEach(r=>r.ptIds=r.ptIds.filter(i=>!ids.has(i)));
  store.routes=store.routes.filter(r=>r.ptIds.length>=2);
  store.imports=store.imports.filter(i=>i.id!==id);
  store.layers.hiddenImports=(store.layers.hiddenImports||[]).filter(i=>i!==id);
  state.currentRoute=state.currentRoute.filter(i=>!ids.has(i));
  /* 消した点を指したままの取消・やり直しを残すと、
     ［取消］で「どこにも無い点でできた計測線」が復活して保存されてしまう。 */
  clearUndoStacks();
  invalidatePtMap(); invalidatePlotMap();
  save(); draw(); updateListCount(); refreshEdits();
  toast(`「${imp.name}」を削除しました`);
}

/* ================= 復元点CSV出力 =================
   ヘッダーなし、Shift-JIS。取込ファイル順、その中ではSIMAのA01順（idx）で出す。
   列: 点番, 点名, X, Y, Z, マーク, 杭種, 点種, リンク, 備考 */
const RESTORATION_CSV_MARK = '12,1.0,1,1';
function csvNum(v){
  let n=+v; if(!isFinite(n)) n=0;
  let t=n.toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
  return t==='-0' ? '0' : t;
}
function csvCell(v){
  const t=String(v==null?'':v);
  return /[",\r\n]/.test(t) ? '"'+t.replace(/"/g,'""')+'"' : t;
}
function restorationCsvPoints(){
  const impOrder=new Map(store.imports.map((x,i)=>[x.id,i]));
  const sourceOrder=new Map(store.points.map((p,i)=>[p.id,i]));
  return store.points.slice().sort((a,b)=>{
    const ai=impOrder.has(a.impId)?impOrder.get(a.impId):Number.MAX_SAFE_INTEGER;
    const bi=impOrder.has(b.impId)?impOrder.get(b.impId):Number.MAX_SAFE_INTEGER;
    if(ai!==bi) return ai-bi;
    const ax=Number.isFinite(+a.idx)?+a.idx:sourceOrder.get(a.id);
    const bx=Number.isFinite(+b.idx)?+b.idx:sourceOrder.get(b.id);
    return ax-bx;
  });
}
function buildRestorationCsv(points){
  const rows=(points||restorationCsvPoints()).map(p=>{
    const [X,Y]=pointToXY(p);
    const stake=recStake(p)||normalizeStakeName(p.stake||'');
    return [p.no||'',p.name||'',csvNum(X),csvNum(Y),csvNum(p.z||0),
      RESTORATION_CSV_MARK,stake,'','',stOf(p)==='ki'?'既設点':'']
      .map(csvCell).join(',');
  });
  return rows.length ? rows.join('\r\n')+'\r\n' : '';
}
function toSjis(text){
  return new Uint8Array(Encoding.convert(Encoding.stringToCode(text),'SJIS','UNICODE'));
}
function exportRestorationCsv(){
  const points=restorationCsvPoints();
  if(!points.length){ alert('出力する境界点がありません。'); return false; }
  const csv=buildRestorationCsv(points);
  download(new Blob([toSjis(csv)],{type:'text/csv'}), `境界復元_復元点_${todayStr()}.csv`);
  toast(`復元点 ${points.length}点をCSVで出力しました`);
  return true;
}

/* ================= 控え（JSON） ================= */
function safeFileName(s){ return String(s||'').replace(/[\\/:*?"<>|]/g,'_').trim(); }
function exportJson(){
  const nm=safeFileName(activeSiteName());
  download(new Blob([JSON.stringify(JSON.parse(siteJson()),null,1)],{type:'application/json'}),
           `境界復元_${nm?nm+'_':''}控え_${todayStr()}.json`);
  store.settings.lastExport=realTodayStr();
  save(); renderRibbon();
  toast('控えを保存しました');
  hideAlert();
}
function updateBackupHint(){}
async function openSnapshots(){
  const box=document.getElementById('snapList');
  box.innerHTML='<p style="color:#888;font-size:14px;">読込中…</p>';
  openPanel('snapPanel');
  let all=[];
  try{ all=await idbReq('snapshots','readonly',s=>s.getAll()); }
  catch(e){ box.innerHTML='<p style="color:#888;font-size:14px;">自動バックアップを読み込めません。</p>'; return; }
  all=all.filter(r=>(r.siteId||'')===(sites.active||''));   // いまの現場のぶんだけ
  all.sort((a,b)=>a.id<b.id?1:-1);
  if(!all.length){ box.innerHTML='<p style="color:#888;font-size:14px;">まだ自動バックアップがありません。</p>'; return; }
  box.innerHTML=all.map(r=>{
    const t=new Date(r.id);
    const ts=isNaN(t)?r.id:`${r.date} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    return `<button type="button" class="menuItem" onclick="restoreSnapshot('${esc(r.id)}')">🕘 ${ts}
      <span class="sub">点 ${r.pt} / 計測線 ${r.rt} / メモ ${r.st}</span></button>`;
  }).join('');
}
async function restoreSnapshot(id){
  let rec=null;
  try{ rec=await idbGet('snapshots',id); }catch(e){}
  if(!rec){ toast('この控えを読み込めません'); return; }
  if(!confirm(`${id.slice(0,19).replace('T',' ')} の状態（点${rec.pt}）に戻します。\n現在のデータは置き換わります。よろしいですか?`)) return;
  try{
    await pushSnapshot(snapshotJson());
    const d=JSON.parse(rec.json);
    applyLoaded(d);
    stakeList();
    state.currentRoute=[]; clearUndoStacks();
    savePending=true; await flushSave();
    closePanel('snapPanel'); updateActionbar(); updateListCount(); draw();
    toast('自動バックアップから復元しました');
  }catch(e){ alert('復元に失敗しました: '+(e.message||e)); }
}
document.getElementById('fileJson').addEventListener('change', async e=>{
  const file=e.target.files[0]; if(!file) return;
  e.target.value='';
  try{
    const d=JSON.parse(await file.text());
    if(!isFukugenData(d)) throw new Error('境界復元アプリの控えではありません');
    if(!confirm(`現在のデータを読込内容（点${d.points.length}）で置き換えます。よろしいですか?`)) return;
    await pushSnapshot(snapshotJson());
    applyLoaded(d);
    const incoming=Object.assign({},d.settings);
    delete incoming.mockDate; delete incoming.mockGps;
    Object.assign(store.settings,incoming);
    state.currentRoute=[]; clearUndoStacks();
    stakeList();
    save(); updateMockLabel(); updateActionbar(); updateListCount(); draw();
    toast('控えを読み込みました');
  }catch(err){ alert('読込に失敗しました: '+err.message); }
});
/* 他の人の控えを合流（置き換えではなく追加。同じidのものは飛ばす） */
let pendingMerge=null;
document.getElementById('fileMerge').addEventListener('change', async e=>{
  const file=e.target.files[0]; if(!file) return;
  e.target.value='';
  try{
    const d=JSON.parse(await file.text());
    if(!isFukugenData(d)) throw new Error('境界復元アプリの控えではないようです');
    pendingMerge={ file, data:d };
    showMergeChoice();
  }catch(err){ alert('読み込みに失敗しました: '+(err&&err.message||err)); }
});
function showMergeChoice(){
  const {file, data:d}=pendingMerge;
  const workers=[...new Set((d.points||[]).map(p=>p.rec&&p.rec.w).filter(Boolean))];
  const done=(d.points||[]).filter(p=>p.rec&&(p.rec.k==='da'||p.rec.k==='ki')).length;
  const other = d.siteId && sites.active && d.siteId!==sites.active;
  document.getElementById('mergeInfo').innerHTML =
    `<div class="noteBox">ファイル: <b>${esc(file.name)}</b><br>`
    + (d.siteName?`控えの現場: <b>${esc(d.siteName)}</b><br>`:'')
    + `境界点 <b>${(d.points||[]).length}</b>（記録済み ${done}）／画地 ${(d.lines||[]).length}／計測線 ${(d.routes||[]).length}<br>`
    + `記録者: ${esc(workers.join('、')||'（未設定）')}</div>`
    + (other?`<div class="noteBox" style="background:#fdecea;border-color:#f0b7b1;color:#8c1d18;">
        ⚠ この控えは<b>別の現場</b>のものです（いま開いているのは「${esc(activeSiteName())}」）。<br>
        合流すると混ざります。ふつうは<b>［新しい現場として読む］</b>を選んでください。</div>`:'');
  const nb=document.getElementById('mergeNewBtn');
  if(nb){
    const full=siteFull();
    nb.disabled=full;
    nb.style.opacity=full?'.45':'';
    nb.textContent=full?`新しい現場として読む（${siteMax()}件で満杯）`:'新しい現場として読む';
  }
  openPanel('mergePanel');
}
function cancelMerge(){ pendingMerge=null; closePanel('mergePanel'); }
async function doMergeHere(){
  if(!pendingMerge) return;
  const d=pendingMerge.data;
  pendingMerge=null; closePanel('mergePanel');
  await pushSnapshot(snapshotJson());
  const r=mergeStore(d);
  clearUndoStacks();
  invalidatePtMap(); invalidatePlotMap();
  save(); updateActionbar(); updateListCount(); draw();
  alert(`いまの現場「${activeSiteName()}」へ読み込みました。\n\n`
    +`境界点: ${r.addP}件を追加（重複 ${r.skipP}件は飛ばしました）\n`
    +`そのうち記録の入った点: ${r.recP}件\n`
    +`同じ点に既に記録があってそのままにした: ${r.keepP}件\n`
    +`基準点 ${r.addRef} / 画地 ${r.addL} / 計測線 ${r.addR} / メモ ${r.addS} / ファイル ${r.addI}`);
}
async function doMergeAsNew(){
  if(!pendingMerge) return;
  const {file, data:d}=pendingMerge;
  const base=(d.siteName||file.name.replace(/\.[^.]+$/,'')||'現場').slice(0,30);
  const name=prompt('新しい現場の名前を入れてください。', base);
  if(name===null) return;
  pendingMerge=null; closePanel('mergePanel');
  const rec=await createSite(name, d);
  if(!rec) return;
  const c=progCounts();
  alert(`現場「${rec.name}」として読み込みました。\n\n`
    +`境界点 ${c.all}（記録済み ${c.done}）／画地 ${store.lines.length}／計測線 ${store.routes.length}`);
}
function mergeStore(d){
  const r={addP:0,skipP:0,recP:0,keepP:0,addRef:0,addL:0,addR:0,addS:0,addI:0};
  const iid=new Set(store.imports.map(x=>x.id));
  for(const x of (d.imports||[])){ if(iid.has(x.id)) continue; store.imports.push(x); iid.add(x.id); r.addI++; }
  const pid=new Map(store.points.map(p=>[p.id,p]));
  for(const p of (d.points||[])){
    if(p&&p.rec&&p.rec.s) p.rec.s=normalizeStakeName(p.rec.s);
    if(p&&p.stake) p.stake=normalizeStakeName(p.stake);
    const cur=pid.get(p.id);
    if(cur){
      r.skipP++;
      /* 同じ点は座標を触らず、記録だけ拾う。既に記録があるものは残す（後勝ちにしない） */
      const has=p.rec&&(p.rec.k==='da'||p.rec.k==='ki');
      if(has && stOf(cur)==='no'){ cur.rec=Object.assign({},p.rec); r.recP++; }
      else if(has) r.keepP++;
      continue;
    }
    store.points.push(p); pid.set(p.id,p); r.addP++;
    if(p.rec&&(p.rec.k==='da'||p.rec.k==='ki')) r.recP++;
  }
  const rfid=new Set(store.refPoints.map(x=>x.id));
  for(const x of (d.refPoints||[])){ if(rfid.has(x.id)) continue; store.refPoints.push(x); rfid.add(x.id); r.addRef++; }
  const lid=new Set(store.lines.map(x=>x.id));
  for(const x of (d.lines||[])){ if(lid.has(x.id)) continue; store.lines.push(x); lid.add(x.id); r.addL++; }
  const rid=new Set(store.routes.map(x=>x.id));
  const rkey=new Set(store.routes.map(x=>(x.ptIds||[]).join('>')));
  for(const x of (d.routes||[])){
    if(rid.has(x.id)) continue;
    const k=(x.ptIds||[]).join('>');
    if(rkey.has(k)) continue;
    store.routes.push(x); rid.add(x.id); rkey.add(k); r.addR++;
  }
  const skey=new Set(store.strokes.map(x=>JSON.stringify(x)));
  for(const x of (d.strokes||[])){ const k=JSON.stringify(x); if(skey.has(k)) continue; store.strokes.push(x); skey.add(k); r.addS++; }
  return r;
}
/* いまの現場の中身だけを空にする（他の現場・端末の設定は残る） */
async function clearSite(){
  const c=progCounts();
  if(!confirm(`【空にするもの】現場「${activeSiteName()}」の中身\n`
    + `　境界点${c.all}（記録済み${c.done}）／画地${store.lines.length}／計測線${store.routes.length}／基準点${store.refPoints.length}／メモ${store.strokes.length}\n`
    + `【残るもの】ほかの現場、作業者名・杭種などの端末の設定、地図の控え\n`
    + `【元に戻せるか】［取消］では戻せません。直前の状態を自動控えに残すので、そこからなら戻せます\n\n`
    + `空にしますか?`)) return;
  if(!confirm(`本当に「${activeSiteName()}」を空にしますか?`)) return;
  await pushSnapshot(snapshotJson());
  const zone=store.settings.zone;
  resetStoreData();
  store.settings.zone=zone;
  fillDefaults();
  clearUndoStacks();
  savePending=true; await flushSave();
  updateMockLabel(); afterSiteChange();
  toast(`「${activeSiteName()}」を空にしました（自動控えから復元できます）`);
}
/* 全部の現場を消して、空の「現場１」だけにする */
async function clearAllSites(){
  const n=siteList().length;
  const tot=siteList().reduce((a,x)=>a+(x.pts||0),0);
  if(!confirm(`【削除するもの】この端末の<b>全${n}現場</b>すべて\n`.replace(/<[^>]+>/g,'')
    + `　境界点は合わせて約${tot}点。自動控えもすべて消えます\n`
    + `【残るもの】作業者名・杭種・文字サイズなどの端末の設定と、地図の控え\n`
    + `【元に戻せるか】戻せません\n\n`
    + `削除しますか?`)) return;
  if(!confirm(`本当に全${n}現場を消しますか?　この操作は戻せません。`)) return;
  if(!confirm('最終確認です。すべての現場の記録が消えます。よろしいですか?')) return;
  for(const x of siteList()){
    try{ await idbReq(DB_STORE,'readwrite',st=>st.delete(siteKey(x.id))); }catch(e){}
  }
  try{ await idbReq('snapshots','readwrite',st=>st.clear()); }catch(e){}
  try{ await idbReq(DB_STORE,'readwrite',st=>st.delete(DB_KEY)); }catch(e){}   // v0.6以前の名残
  try{ localStorage.removeItem(LS_KEY); localStorage.removeItem(LEGACY_LS_KEY); }catch(e){}
  const id=newId(), now=new Date().toISOString();
  sites={ list:[{ id, name:'現場１', created:now, updated:now, pts:0, done:0, lines:0 }], active:id };
  resetStoreData();
  fillDefaults();
  clearUndoStacks();
  lastSavedJson='';
  savePending=true; await flushSave();
  updateMockLabel(); afterSiteChange();
  toast(`全${n}現場を削除しました`);
}
<!--@SRC:5309-5314-->

/* ================= パネル/トースト ================= */
<!--@SRC:5316-5365-->

/* ================= 画面スリープ抑止 ================= */
<!--@SRC:5367-5385-->

/* ================= オフライン対応（Service Worker） ================= */
function updateOnlineBadge(){
  const el=document.getElementById('offlineBadge');
  if(el) el.style.display = navigator.onLine ? 'none' : 'inline';
}
window.addEventListener('online', updateOnlineBadge);
window.addEventListener('offline', updateOnlineBadge);
function setupPWA(){
  try{
    const mf={ name:appFull(), short_name:APP_NAME, start_url:location.pathname,
      scope:'./', display:'standalone', orientation:'any',
      background_color:'#ffffff', theme_color:'#1e3a5f' };
    if(ICON_URL) mf.icons=[{src:ICON_URL, sizes:'512x512', type:'image/png', purpose:'any'}];
    const link=document.createElement('link');
    link.rel='manifest';
    link.href=URL.createObjectURL(new Blob([JSON.stringify(mf)],{type:'application/manifest+json'}));
    document.head.appendChild(link);
    const ic=document.createElement('link');
    ic.rel='apple-touch-icon'; ic.href=ICON_URL;
    document.head.appendChild(ic);
  }catch(e){}
  if(!('serviceWorker' in navigator)) return;
  if(location.protocol!=='https:' && location.hostname!=='localhost' && location.hostname!=='127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').then(reg=>{
    navigator.serviceWorker.ready.then(r=>{
      const sw=r.active||reg.active;
      if(sw) sw.postMessage({type:'cache-self', url:location.href.split('#')[0]});
    }).catch(()=>{});
    reg.addEventListener('updatefound',()=>{
      const nw=reg.installing;
      if(!nw) return;
      nw.addEventListener('statechange',()=>{
        if(nw.state==='installed' && navigator.serviceWorker.controller){
          showAlert('新しいバージョンがあります。',
            [{label:'今すぐ更新',fn:'location.reload()'},{label:'あとで',fn:'hideAlert()'}]);
          document.getElementById('alertBar').style.background='#1e73d2';
        }
      });
    });
  }).catch(()=>{});
}
/* ホーム画面用アイコン（外部ファイルを増やさないためデータURLで内蔵） */
const ICON_URL=(()=>{
  try{
    const c=document.createElement('canvas'); c.width=c.height=512;
    const g=c.getContext('2d');
    g.fillStyle='#1e3a5f'; g.fillRect(0,0,512,512);
    g.strokeStyle='rgba(255,255,255,.28)'; g.lineWidth=6;
    for(let i=1;i<4;i++){ g.beginPath(); g.moveTo(i*128,0); g.lineTo(i*128,512);
      g.moveTo(0,i*128); g.lineTo(512,i*128); g.stroke(); }
    g.strokeStyle='#fff'; g.lineWidth=12;
    g.beginPath(); g.moveTo(96,392); g.lineTo(232,140); g.lineTo(400,300); g.closePath(); g.stroke();
    g.fillStyle='#d9261c'; g.beginPath(); g.arc(232,140,40,0,7); g.fill();
    g.fillStyle='#4a9bf0'; g.beginPath(); g.arc(96,392,40,0,7); g.fill();
    g.fillStyle='#4a9bf0'; g.beginPath(); g.arc(400,300,40,0,7); g.fill();
    return c.toDataURL('image/png');
  }catch(e){ return ''; }
})();

/* ================= 診断 ================= */
<!--@SRC:5448-5459-->

/* ================= 初期化 ================= */
(async function init(){
  try{ await load(); }catch(e){}
  const tEl=document.getElementById('appTitle');
  if(tEl) tEl.innerHTML = `${esc(APP_NAME)} <small style="font-weight:normal;opacity:.7">`
    + `${esc(APP_EDITION)} ${esc(APP_VERSION)}</small>`;
  document.title = appFull();
  applyA11y();
  const hv=document.getElementById('helpVersion');
  if(hv) hv.textContent = `この説明は ${appFull()}（ビルド ${APP_BUILD}）のものです。`;
  resize();
  state.view.scale=2;
  state.viewRestored = restoreView();
  if(!state.viewRestored && store.points.length){
    fitToBox(store.points.map(p=>p.x), store.points.map(p=>p.y));
  }
  state.mode='view';
  updateSiteChip();
  renderRibbon();
  updateActionbar();
  resize();
  updateMockLabel();
  updateListCount();
  updateOnlineBadge();
  setupPWA();
  startGps();
  setInterval(rememberView, 8000);
  if(location.protocol==='file:'){
    setTimeout(()=>toast('GPS利用にはHTTPSでの配置が必要です（使い方参照）'),800);
  }
  if(progCounts().done && daysSince(store.settings.lastExport)>=7){
    setTimeout(()=>{
      showAlert(store.settings.lastExport
        ? `控え（JSON）を${daysSince(store.settings.lastExport)}日間保存していません。`
        : '控え（JSON）をまだ端末外へ保存していません。',
        [{label:'今すぐ保存',fn:'exportJson()'},{label:'あとで',fn:'hideAlert()'}]);
      document.getElementById('alertBar').style.background='#c9741a';
    },1500);
  }
})();
