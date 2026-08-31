/* 境界復元支援アプリ 自動テスト
   実行: python3 prep.py && python3 build.py && node test.mjs */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const here = dirname(fileURLToPath(import.meta.url));
const APP  = join(here, 'dist', 'fukugen-map.html');
const SIM  = join(here, 'sample', '画地サンプル.sim');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra !== undefined ? `  → ${JSON.stringify(extra)}` : '')); }
}
function eq(name, got, want) { ok(name, got === want, { got, want }); }
function near(name, got, want, tol) { ok(name, Math.abs(got - want) <= tol, { got, want, tol }); }

const simText = readFileSync(SIM, 'latin1'); // バイト列としてそのまま渡す（アプリ側でSJIS判定させる）
const simBytes = Array.from(readFileSync(SIM));

/* IndexedDB や Service Worker は file:// では使えないので、簡易サーバで配る */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json' };
const srv = createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'fukugen-map.html';
  const f = join(here, 'dist', name);
  if (!existsSync(f)) { res.writeHead(404); res.end('no'); return; }
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}/fukugen-map.html`;

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {});
/* 保存データを見るため、2枚のページは同じコンテキスト（同じ端末）で開く */
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
  if (m.type() === 'error') {
    const at=m.location().url;
    errors.push('console: ' + m.text() + (at ? ` @ ${at}` : ''));
  }
});
await page.addInitScript(() => { self.__noTiles = true; });
await page.goto(BASE);
await page.waitForFunction(() => typeof draw === 'function' && typeof store === 'object');
await page.waitForTimeout(300);

/* ---------- 1. 起動 ---------- */
ok('起動時にエラーが出ない', errors.length === 0, errors.slice(0, 3));
eq('版数', await page.evaluate(() => APP_VERSION), 'v0.9');
eq('アプリ名', await page.evaluate(() => APP_NAME), '境界復元');
eq('専用IndexedDB名', await page.evaluate(() => DB_NAME), 'kyokaiFukugenMap');
eq('専用localStorage名', await page.evaluate(() => LS_KEY), 'kyokaiFukugenMapData_v1');
eq('保存データの識別子', await page.evaluate(() => store.appId), 'kyokai-fukugen-map-v1');
ok('タイトルに境界復元が入る', (await page.title()).includes('境界復元'));
ok('ビルド情報が入っている', /^\d{4}-\d{2}-\d{2} \([0-9a-f]{12}\)$/.test(await page.evaluate(() => APP_BUILD)),
   await page.evaluate(() => APP_BUILD));

/* ---------- 2. 消したはずの機能が無い ---------- */
for (const fn of ['buildSima', 'saveSima', 'buildCsv', 'saveCsv', 'exportSimaToday', 'exportCsvToday',
                  'buildSfc', 'exportSfc', 'buildDxf', 'exportDxf', 'exportKanri', 'exportKanriCsv',
                  'kanriRows', 'openDaily', 'markSvg', 'openMarkPicker', 'setDefaultMark',
                  'registerPoint', 'commitPoint', 'startFix', 'finishFix', 'toggleFreeMode',
                  'commitFreePoint', 'markInstalled', 'tapInstall']) {
  eq(`${fn} が無い`, await page.evaluate(f => { try { return typeof eval(f); } catch (e) { return 'undefined'; } }, fn), 'undefined');
}
for (const v of ['MARK_SPRITE', 'XLTPL_REST', 'XLTPL_PREFIX', 'SFC_SCALES']) {
  eq(`${v} が無い`, await page.evaluate(v2 => { try { return typeof eval(v2); } catch (e) { return 'undefined'; } }, v), 'undefined');
}
eq('マークのスプライト画像が本体に無い', readFileSync(APP, 'utf8').includes('MARK_SPRITE'), false);
eq('様式5のテンプレートが本体に無い', readFileSync(APP, 'utf8').includes('XLTPL_REST'), false);

/* ---------- 3. 残すはずの機能がある ---------- */
for (const fn of ['startGps', 'drawBaseMap', 'cacheViewTiles', 'clearTileCache', 'openTiffs',
                  'exportJson', 'openSnapshots', 'mergeStore', 'setupPWA', 'toggleMock',
                  'openMockDate', 'showStorageInfo', 'clearStrokes', 'undoStroke']) {
  eq(`${fn} がある`, await page.evaluate(f => { try { return typeof eval(f); } catch (e) { return 'undefined'; } }, fn), 'function');
}

/* ---------- 4. リボン ---------- */
const tabs = await page.evaluate(() => RIBBON.map(t => t.id + ':' + t.label));
eq('タブは6つ', tabs.length, 6);
eq('タブの並び', tabs.join(','), 'prep:準備,rec:復元,meas:計測,memo:メモ,check:確認,data:データ');
const tabBtns = await page.$$eval('#ribbonTabs button', bs => bs.map(b => b.textContent.trim()));
eq('画面のタブも6つ', tabBtns.length, 6);
ok('準備タブに境界点取込がある', (await page.content()).includes('境界点取込'));

/* ---------- 5. 年代別の航空写真 ---------- */
const tiles = await page.evaluate(() => Object.keys(GSI_TILES).map(k =>
  ({ k, name: GSI_TILES[k].name, min: GSI_TILES[k].min, max: GSI_TILES[k].max, url: GSI_TILES[k].url })));
const byId = Object.fromEntries(tiles.map(t => [t.k, t]));
for (const id of ['std', 'pale', 'photo', 'ort', 'gazo1', 'gazo2', 'gazo3', 'gazo4',
                  'ort_old10', 'ort_USA10', 'blank']) {
  ok(`背景地図に ${id} がある`, !!byId[id]);
}
eq('年代別を含めて11種', tiles.length, 11);
eq('1945-1950は米軍と分かる', byId.ort_USA10.name.includes('米軍'), true);
eq('古い写真のズーム上限は17', byId.ort_old10.max, 17);
eq('古い写真のズーム下限は10', byId.ort_old10.min, 10);
eq('最新写真のズーム上限は18', byId.photo.max, 18);
eq('2007年〜は14段から', byId.ort.min, 14);
eq('1961〜1969年の表記', byId.ort_old10.name, '空中写真 1961〜1969年');
eq('1987〜1990年の表記', byId.gazo4.name, '空中写真 1987〜1990年');
eq('古い写真はpng', byId.ort_USA10.url.endsWith('.png'), true);
eq('国土画像情報はjpg', byId.gazo1.url.endsWith('.jpg'), true);
for (const t of tiles) {
  if (!t.url) continue;
  ok(`${t.k} は地理院タイルのURL`, t.url.startsWith('https://cyberjapandata.gsi.go.jp/xyz/'), t.url);
  ok(`${t.k} のURLに {z}/{x}/{y}`, /\{z\}\/\{x\}\/\{y\}/.test(t.url), t.url);
}
eq('出典の文言', await page.evaluate(() => GSI_CREDIT), '地理院タイル（国土地理院）');

/* ---------- 6. SIMAの解析（画地データ） ---------- */
const parsed = await page.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  const r = parseSimaFull(txt);
  return {
    nPts: r.pts.length,
    nPlots: r.plots.length,
    plots: r.plots.map(p => ({ no: p.no, name: p.name, n: p.verts.length })),
    head: r.pts.slice(0, 2),
    firstC03: r.plots[0].verts[0].d,
  };
}, simBytes);
eq('A01の点数', parsed.nPts, 2397);
eq('画地の数', parsed.nPlots, 4);
eq('画地1の名前', parsed.plots[0].name, '野田第４');
eq('画地1の頂点数', parsed.plots[0].n, 836);
eq('画地2の頂点数', parsed.plots[1].n, 1130);
eq('画地3の頂点数', parsed.plots[2].n, 159);
eq('画地4の頂点数', parsed.plots[3].n, 730);
eq('先頭の点名', parsed.head[0].name, 'FK12863');
near('先頭のX(北)', parsed.head[0].X, -39525.623, 1e-6);
near('先頭のY(東)', parsed.head[0].Y, 60295.494, 1e-6);
near('最初のC03辺長', parsed.firstC03, 9.485, 1e-9);

/* ---------- 7. 取り込み（境界点として） ---------- */
const imp = await page.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: '画地サンプル.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '野田地区';
  commitImport();
  return {
    pts: store.points.length,
    refs: store.refPoints.length,
    lines: store.lines.length,
    imports: store.imports.length,
    kind: store.imports[0].kind,
    name: store.imports[0].name,
    closed: store.lines.map(l => l.closed),
    segs: store.lines.map(l => l.ptIds.length),
    firstName: store.points[0].name,
  };
}, simBytes);
eq('境界点として2397点', imp.pts, 2397);
eq('基準点は0点', imp.refs, 0);
eq('画地の線は4本', imp.lines, 4);
eq('取込ファイルは1件', imp.imports, 1);
eq('種別は境界点', imp.kind, 'bp');
eq('呼び名', imp.name, '野田地区');
eq('4画地すべて閉じた線', imp.closed.join(','), 'true,true,true,true');
eq('画地1の頂点数（取込後）', imp.segs[0], 836);
eq('先頭の点名（取込後）', imp.firstName, 'FK12863');

/* ---------- 8. 座標の向きと距離 ---------- */
const geo = await page.evaluate(() => {
  const p = store.points[0];
  const ll = xyToLL(p.x, p.y, 1);
  return { x: p.x, y: p.y, lon: ll && ll[0], lat: ll && ll[1] };
});
near('内部座標 x は東(Y)', geo.x, 60295.494, 1e-6);
near('内部座標 y は北(X)', geo.y, -39525.623, 1e-6);
ok('第1系で長崎県南部の経度になる', geo.lon > 130.0 && geo.lon < 130.5, geo.lon);
ok('第1系で長崎県南部の緯度になる', geo.lat > 32.4 && geo.lat < 32.8, geo.lat);

const dist = await page.evaluate(() => {
  const idx = ptIndex();
  let n = 0, bad = 0, worst = 0, sum = 0;
  for (const l of store.lines) {
    const ids = l.ptIds, m = ids.length;
    const segs = l.closed ? m : m - 1;
    for (let i = 0; i < segs; i++) {
      const a = idx.get(ids[i]), b = idx.get(ids[(i + 1) % m]);
      const d = l.dists[i];
      if (!a || !b || !isFinite(d)) { bad++; continue; }
      const c = distBetween(a, b);
      worst = Math.max(worst, Math.abs(c - d));
      sum += d; n++;
    }
  }
  return { n, bad, worst, sum };
});
eq('辺の総数', dist.n, 2855);
eq('辺長の抜けなし', dist.bad, 0);
ok('C03の辺長と座標から計算した距離が1mm以内で一致', dist.worst < 0.001, dist.worst);
ok('総延長がそれらしい値', dist.sum > 10000 && dist.sum < 60000, dist.sum);

/* ---------- 9. 距離の表示（レイヤと閾値） ---------- */
eq('距離レイヤは既定で表示', await page.evaluate(() => store.layers.dist), true);
await page.evaluate(() => { toggleLayer('dist'); });
eq('距離レイヤを消せる', await page.evaluate(() => store.layers.dist), false);
await page.evaluate(() => { toggleLayer('dist'); });
eq('距離レイヤを戻せる', await page.evaluate(() => store.layers.dist), true);
const distDraw = await page.evaluate(() => {
  // 描画に回った距離ラベルの数を数える（drawDistLabel を差し替えて数える）
  const org = window.drawDistLabel;
  let n = 0; const texts = [];
  window.drawDistLabel = (A, B, t, px) => { n++; if (texts.length < 3) texts.push(t); };
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));   // 全体を見る
  const wide = n; n = 0;
  fitToLine(store.lines[2].id);                        // 画地1つへ寄る
  state.view.scale = state.view.scale * 12; draw();    // さらに拡大する
  const zoom = n;
  window.drawDistLabel = org;
  return { wide, zoom, texts };
});
eq('全体表示では距離を出さない', distDraw.wide, 0);
ok('拡大すると距離が出る', distDraw.zoom > 0, distDraw.zoom);
ok('距離は小数3桁', distDraw.texts.every(t => /^\d+\.\d{3}$/.test(t)), distDraw.texts);
const thin = await page.evaluate(() => {
  const org = window.drawDistLabel;
  let n = 0;
  window.drawDistLabel = () => { n++; };
  store.settings.thinDist = 400; draw(); const strict = n; n = 0;
  store.settings.thinDist = 10;  draw(); const loose = n;
  store.settings.thinDist = 40;
  window.drawDistLabel = org; draw();
  return { strict, loose };
});
ok('閾値を上げると距離ラベルが減る', thin.strict < thin.loose, thin);

/* ---------- 10. 点の間引き ---------- */
const modes = await page.evaluate(() => {
  const out = {};
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));  // 全体
  out.all = state.drawInfo.mode; out.allN = state.drawInfo.n;
  fitToPoint(store.points[0].id);
  state.view.scale = 4; draw();  out.mid = state.drawInfo.mode;
  state.view.scale = 40; draw(); out.near = state.drawInfo.mode;
  return out;
});
eq('全体表示は点だけ表示', modes.all, 'dot');
eq('全体では2397点が画面内', modes.allN, 2397);
eq('十分に拡大すると点名まで出る', modes.near, 'name');
const thinPt = await page.evaluate(() => {
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  store.settings.thinPt = 5000; store.settings.thinName = 5000; draw();
  const a = state.drawInfo.mode;
  store.settings.thinPt = 300; store.settings.thinName = 150; draw();
  return { a, b: state.drawInfo.mode };
});
eq('上限を上げれば全体でも点名が出る', thinPt.a, 'name');
eq('上限を戻せば点だけ表示に戻る', thinPt.b, 'dot');

/* ---------- 11. 打設 / 既設 の記録 ---------- */
const rec = await page.evaluate(() => {
  const a = store.points[0].id, b = store.points[1].id, c = store.points[2].id;
  const out = {};
  out.before = progCounts();
  store.settings.worker = '森';
  setRec(a, 'da', 'コンクリート杭');
  setRec(b, 'ki', '金属鋲');
  out.after = progCounts();
  out.stA = stOf(ptById(a)); out.stB = stOf(ptById(b)); out.stC = stOf(ptById(c));
  out.recA = ptById(a).rec;
  undoRec();
  out.afterUndo = progCounts();
  out.stBundo = stOf(ptById(b));
  redoRec();
  out.afterRedo = progCounts();
  clearRec(a);
  out.afterClear = progCounts();
  out.stAclear = stOf(ptById(a));
  return out;
});
eq('はじめは全部「未」', rec.before.no, 2397);
eq('打設が1点', rec.after.da, 1);
eq('既設が1点', rec.after.ki, 1);
eq('未が2395点', rec.after.no, 2395);
eq('記録済みが2点', rec.after.done, 2);
eq('1点目は打設', rec.stA, 'da');
eq('2点目は既設', rec.stB, 'ki');
eq('3点目は未のまま', rec.stC, 'no');
eq('記録に杭種が入る', rec.recA.s, 'コンクリート杭');
eq('記録に作業者が入る', rec.recA.w, '森');
ok('記録に日付が入る', /^\d{4}-\d{2}-\d{2}$/.test(rec.recA.d), rec.recA.d);
eq('取消で既設が戻る', rec.stBundo, 'no');
eq('取消後は記録1点', rec.afterUndo.done, 1);
eq('やり直しで2点に戻る', rec.afterRedo.done, 2);
eq('記録の取り消しで未に戻る', rec.stAclear, 'no');
eq('取り消し後は1点', rec.afterClear.done, 1);
const colors = await page.evaluate(() => ({
  da: stColor('da'), ki: stColor('ki'), no: stColor('no'),
  name: [ST_NAME.da, ST_NAME.ki, ST_NAME.no].join('/')
}));
eq('打設は赤', colors.da.toLowerCase(), '#d9261c');
eq('既設は青', colors.ki.toLowerCase(), '#1e73d2');
eq('未は灰', colors.no.toLowerCase(), '#8a8f96');
eq('状態の呼び名', colors.name, '打設/既設/未');

/* ---------- 12. 記録画面 ---------- */
const recUI = await page.evaluate(() => {
  const id = store.points[10].id;
  openRec(id);
  const html = document.getElementById('recBody').innerHTML;
  const shown = document.getElementById('recPanel').classList.contains('show');
  const title = document.getElementById('recTitle').textContent;
  recPickSetStake('アルミプレート'); recCommit('ki');
  const p = ptById(id);
  return { shown, title, want: p.name, hasDa: html.includes('打設'), hasKi: html.includes('既設'),
           hasStake: html.includes('アルミプレート'), st: stOf(p), stake: p.rec.s,
           carried: store.settings.stake };
});
eq('記録画面が開く', recUI.shown, true);
eq('見出しは点名', recUI.title, recUI.want);
ok('打設のボタンがある', recUI.hasDa);
ok('既設のボタンがある', recUI.hasKi);
ok('杭種の一覧にアルミプレートがある', recUI.hasStake);
eq('選んで記録できる', recUI.st, 'ki');
eq('選んだ杭種が入る', recUI.stake, 'アルミプレート');
eq('杭種は次に引き継がれる', recUI.carried, 'アルミプレート');

/* ---------- 12b. 杭種略称は表示だけに付ける ---------- */
const stakeSuffix = await page.evaluate(() => {
  const pairs = [
    ['プラスチック杭','P'], ['金属鋲','B'], ['金属標','K'],
    ['アルミプレート','L'], ['ペンキ','M'], ['コンクリート杭','C']
  ];
  const labels = pairs.map(([s]) => displayPointName({name:'A1',rec:{k:'da',s}}));
  const abbrs = pairs.map(([s]) => stakeAbbr(s));
  const p = store.points[10]; // 直前のテストでアルミプレートを記録済み
  const rawName = p.name;
  openRec(p.id);
  const recTitle = document.getElementById('recTitle').textContent;
  ptSearch=rawName; ptGroup='none'; openList('pt');
  const listHas = document.getElementById('pointList').textContent.includes(rawName+'L');
  const org = window.labelNoOverlap, drawn=[];
  window.labelNoOverlap = (x,y,t) => { drawn.push(t); return true; };
  fitToPoint(p.id); state.view.scale=40; draw();
  window.labelNoOverlap = org;
  ptSearch=''; closePanel('recPanel'); closePanel('listPanel');
  return {
    abbrs, labels, rawName, storedName:p.name, recTitle, listHas,
    mapHas:drawn.includes(rawName+'L'),
    unrecorded:displayPointName({name:'A1'}),
    unknown:displayPointName({name:'A1',rec:{k:'ki',s:'独自杭'}})
  };
});
eq('6種類の杭種略称', stakeSuffix.abbrs.join('/'), 'P/B/K/L/M/C');
eq('点名の後に略称を表示', stakeSuffix.labels.join('/'), 'A1P/A1B/A1K/A1L/A1M/A1C');
eq('未記録の点名には略称を付けない', stakeSuffix.unrecorded, 'A1');
eq('略称未定義の独自杭は元の点名を表示', stakeSuffix.unknown, 'A1');
eq('保存された点名は改名しない', stakeSuffix.storedName, stakeSuffix.rawName);
eq('記録画面の点名に略称を表示', stakeSuffix.recTitle, stakeSuffix.rawName+'L');
ok('一覧の点名に略称を表示', stakeSuffix.listHas);
ok('地図の点名に略称を表示', stakeSuffix.mapHas, stakeSuffix);

/* ---------- 13. 基準点は記録できない ---------- */
const ref = await page.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: '基準点.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'ref';
  document.getElementById('impName').value = '基準点';
  commitImport();
  const r = store.refPoints[0];
  const before = progCounts().all;
  openRec(r.id);
  const opened = document.getElementById('recPanel').classList.contains('show');
  return { refs: store.refPoints.length, pts: before, opened, isRef: !!r.ref,
           kind: store.imports[1].kind, visible: isRefVisible(r) };
}, simBytes);
eq('基準点として取り込める', ref.refs, 2397);
eq('境界点の数は増えない', ref.pts, 2397);
eq('基準点の印がつく', ref.isRef, true);
eq('取込の種別は基準点', ref.kind, 'ref');
eq('基準点は記録画面を開かない', ref.opened, false);

/* ---------- 14. 計測線 ---------- */
const meas = await page.evaluate(() => {
  const a = store.points[0], b = store.points[1], c = store.points[2];
  state.currentRoute = [a.id, b.id];
  const live = routeLength(state.currentRoute);
  commitRoute();
  const r = store.routes[0];
  const d = routeLength(r.ptIds);
  state.currentRoute = [a.id, b.id, c.id];
  commitRoute();
  const d3 = routeLength(store.routes[1].ptIds);
  const before = store.routes.length;
  const idx = ptIndex();
  const truth = Math.hypot(a.x - b.x, a.y - b.y);
  return { live, d, d3, n: before, truth, label: routeLabel(r), ids: r.ptIds.length };
});
near('2点の距離が正しい', meas.d, meas.truth, 1e-9);
near('選んでいる途中も同じ距離', meas.live, meas.truth, 1e-9);
eq('計測線が2本', meas.n, 2);
eq('2点の計測線', meas.ids, 2);
ok('3点なら区間の合計', meas.d3 > meas.d, { d3: meas.d3, d: meas.d });
ok('計測線の見出しは点名を並べたもの', meas.label.includes('－'), meas.label);
const measUndo = await page.evaluate(() => {
  clearRoutes.__orig = window.confirm;
  window.confirm = () => true;
  const n0 = store.routes.length;
  clearRoutes();
  const n1 = store.routes.length;
  undoRoute();
  const n2 = store.routes.length;
  redoRoute();
  const n3 = store.routes.length;
  undoRoute();
  window.confirm = clearRoutes.__orig;
  return { n0, n1, n2, n3, n4: store.routes.length };
});
eq('全削除で0本', measUndo.n1, 0);
eq('取消で戻る', measUndo.n2, measUndo.n0);
eq('やり直しで消える', measUndo.n3, 0);
eq('もう一度取消で戻る', measUndo.n4, measUndo.n0);

/* ---------- 15. 状態でしぼる ---------- */
const filt = await page.evaluate(() => {
  // 打設・既設・未がそろった状態にしてから確かめる
  for (let i = 0; i < 5; i++)  setRec(store.points[i].id, 'da', 'コンクリート杭');
  for (let i = 5; i < 12; i++) setRec(store.points[i].id, 'ki', '金属鋲');
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  const out = { c: progCounts() };
  draw(); out.all = state.drawInfo.n;
  store.layers.stNone = false; draw(); out.hideNone = state.drawInfo.n;
  store.layers.stNone = true; store.layers.stDa = false; draw(); out.hideDa = state.drawInfo.n;
  store.layers.stDa = true; store.layers.stKi = false; draw(); out.hideKi = state.drawInfo.n;
  store.layers.stKi = true; draw();
  return out;
});
eq('打設が5点', filt.c.da, 5);
eq('既設が7点', filt.c.ki, 7);
eq('未を消すと記録済みの12点だけ', filt.hideNone, 12);
eq('打設を消すと5点減る', filt.hideDa, filt.all - 5);
eq('既設を消すと7点減る', filt.hideKi, filt.all - 7);

/* ---------- 16. 保存して読み直す ---------- */
const round = await page.evaluate(async () => {
  savePending = true;
  await flushSave();
  const json = await idbGet(DB_STORE, siteKey(sites.active));   // v0.7から現場ごとのキー
  const d = JSON.parse(json);
  return { pts: d.points.length, lines: d.lines.length, refs: d.refPoints.length,
           routes: d.routes.length, imports: d.imports.length,
           recs: d.points.filter(p => p.rec).length,
           dists: d.lines[0].dists.length };
});
eq('保存された境界点', round.pts, 2397);
eq('保存された画地', round.lines, 4);
eq('保存された基準点', round.refs, 2397);
eq('保存された取込ファイル', round.imports, 2);
eq('保存された辺長', round.dists, 836);
ok('記録も保存される', round.recs >= 1, round.recs);

const page2 = await ctx.newPage();
const errors2 = [];
page2.on('pageerror', e => errors2.push(String(e)));
await page2.addInitScript(() => { self.__noTiles = true; });
await page2.goto(BASE);
await page2.waitForFunction(() => typeof store === 'object' && store.points.length > 0);
await page2.waitForTimeout(200);
const re = await page2.evaluate(() => ({
  pts: store.points.length, lines: store.lines.length, refs: store.refPoints.length,
  done: progCounts().done, chip: document.getElementById('progChip').textContent,
  chipTitle: document.getElementById('progChip').title,
  worker: store.settings.worker
}));
ok('開き直してもエラーが出ない', errors2.length === 0, errors2.slice(0, 3));
eq('開き直して境界点が残る', re.pts, 2397);
eq('開き直して画地が残る', re.lines, 4);
eq('開き直して基準点が残る', re.refs, 2397);
ok('開き直して記録が残る', re.done >= 1, re.done);
ok('ヘッダーに進み具合が出る', /^\d+\/2397$/.test(re.chip.trim()), re.chip);
ok('ヘッダーの説明に内訳が入る', /打設\d+／既設\d+／未\d+/.test(re.chipTitle || ''), re.chipTitle);

/* ---------- 17. 取込ファイルの削除 ---------- */
const del = await page2.evaluate(() => {
  const org = window.confirm; window.confirm = () => true;
  const id = store.imports[0].id;
  delImport(id);
  const out = { pts: store.points.length, lines: store.lines.length,
                refs: store.refPoints.length, imports: store.imports.length };
  window.confirm = org;
  return out;
});
eq('境界点が消える', del.pts, 0);
eq('その画地の線も消える', del.lines, 0);
eq('基準点は残る', del.refs, 2397);
eq('取込ファイルは1件になる', del.imports, 1);

/* ---------- 18. 一覧 ---------- */
const list = await page2.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: 'x.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '野田';
  commitImport();
  setRec(store.points[0].id, 'da', '金属標');
  openList('pt');
  const info = document.getElementById('ptListInfo').textContent;
  const prog = document.getElementById('progInfo').textContent;
  setPtGroup('st');
  const groups = document.getElementById('pointList').textContent;
  setPtSearch('FK12863');
  const found = document.getElementById('pointList').textContent;
  const hits = document.getElementById('ptListInfo').textContent;
  setPtSearch('');
  setPtGroup('plot');
  const plots = document.getElementById('pointList').textContent;
  setPtGroup('none');
  const flat = { more: document.getElementById('ptMoreBox').style.display,
                 rows: document.querySelectorAll('#pointList .listRow').length };
  ptShowMore();
  const flat2 = document.querySelectorAll('#pointList .listRow').length;
  setPtGroup('st'); ptOpenAll();
  const opened = document.getElementById('pointList').textContent;
  ptCloseAll();
  return { info, prog, groups, found, hits, plots, flat, flat2, opened,
           limited: document.getElementById('ptMoreBox').style.display };
}, simBytes);
ok('件数が出る', list.info.includes('2397点中'), list.info);
ok('進み具合が出る', list.prog.includes('2397点中 1点'), list.prog);
ok('状態ごとにまとまる', list.groups.includes('打設') && list.groups.includes('未'), list.groups.slice(0, 80));
ok('検索できる', list.found.includes('FK12863'), list.found.slice(0, 80));
ok('検索の件数が出る', list.hits.includes('検索'), list.hits);
ok('画地ごとにまとまる', list.plots.includes('野田第４'), list.plots.slice(0, 80));
eq('まとめないときは200点ずつ', list.flat.rows, 200);
eq('［さらに表示］が出る', list.flat.more, 'block');
eq('［さらに表示］で400点になる', list.flat2, 400);
eq('まとめているときは［さらに表示］を出さない', list.limited, 'none');
ok('まとまりを開くと件数の案内が出る', list.opened.includes('点中'), list.opened.slice(0, 120));
ok('まとまりは打設も未も出る', list.opened.includes('打設') && list.opened.includes('未'), list.opened.slice(0, 120));

/* ---------- 18b. 一覧から記録する ---------- */
const fromList = await page2.evaluate(() => {
  openList('pt');
  setPtGroup('none'); setPtSort('name');
  const id = store.points.find(p => stOf(p) === 'no').id;
  openRec(id);
  const recZ = +getComputedStyle(document.getElementById('recPanel')).zIndex;
  const lstZ = +getComputedStyle(document.getElementById('listPanel')).zIndex;
  const both = document.getElementById('recPanel').classList.contains('show')
            && document.getElementById('listPanel').classList.contains('show');
  recPickSetStake('金属標'); recCommit('da');
  const p = ptById(id);
  return { recZ, lstZ, both, st: stOf(p), stake: p.rec.s,
           listStill: document.getElementById('listPanel').classList.contains('show') };
});
ok('一覧の上に記録画面が出る', fromList.both && fromList.recZ > fromList.lstZ, fromList);
eq('一覧からも記録できる', fromList.st, 'da');
eq('一覧からの記録にも杭種が入る', fromList.stake, '金属標');
eq('記録しても一覧は開いたまま', fromList.listStill, true);

/* ---------- 19. 杭種 ---------- */
const stakes = await page2.evaluate(() => {
  const org = window.confirm; window.confirm = () => true;
  resetStakes();
  const def = stakeList().slice();
  addStake(); editStake(stakeList().length - 1, '境界標');
  const added = stakeList().slice();
  delStake(stakeList().length - 1);
  const after = stakeList().slice();
  window.confirm = org;
  return { def, added, after };
});
eq('初期の杭種は6種', stakes.def.length, 6);
eq('初期の杭種の並び', stakes.def.join('/'), 'コンクリート杭/プラスチック杭/金属鋲/金属標/アルミプレート/ペンキ');
ok('杭種を足せる', stakes.added.includes('境界標'));
eq('杭種を消せる', stakes.after.length, 6);
const migratedStakes = await page2.evaluate(() => {
  store.settings.stakes=['コンクリート杭','プラスチック杭','金属鋲','金属標','金属プレート','独自杭'];
  store.settings.stakesVer=2;
  store.settings.stake='金属プレート';
  return { list:stakeList().slice(), ver:store.settings.stakesVer, current:store.settings.stake };
});
ok('旧版の杭種へペンキを追加', migratedStakes.list.includes('ペンキ'), migratedStakes);
ok('金属プレートをアルミプレートへ移行', migratedStakes.list.includes('アルミプレート') && !migratedStakes.list.includes('金属プレート'), migratedStakes);
eq('選択中の金属プレートも移行', migratedStakes.current, 'アルミプレート');
ok('利用者が追加した杭種を移行時に保持', migratedStakes.list.includes('独自杭'), migratedStakes);
eq('杭種設定をv4へ移行', migratedStakes.ver, 4);
const badStakes = await page2.evaluate(() => {
  store.settings.stakes=[{name:'コンクリート杭'},{name:'金属鋲'}];
  store.settings.stakesVer=2;
  store.settings.stake='[object Object]';
  return { list:stakeList().slice(), current:store.settings.stake };
});
eq('オブジェクト杭種を6種類へ自動修復', badStakes.list.join('/'), 'コンクリート杭/プラスチック杭/金属鋲/金属標/アルミプレート/ペンキ');
eq('不正な選択中杭種も修復', badStakes.current, 'コンクリート杭');

/* ---------- 19b. 復元点CSV ---------- */
const csvOut = await page2.evaluate(() => {
  const p0=store.points[0], p1=store.points[1];
  p0.rec={k:'ki',d:'2026-08-28',w:'森',s:'アルミプレート',t:1};
  p1.rec={k:'da',d:'2026-08-28',w:'森',s:'ペンキ',t:2};
  const csv=buildRestorationCsv([p0,p1]);
  const rows=csv.trimEnd().split(/\r?\n/).map(splitCsvLine);
  const [X0,Y0]=pointToXY(p0);
  const first=store.points[0], second=store.points[1];
  store.points[0]=second; store.points[1]=first;
  const ordered=restorationCsvPoints();
  store.points[0]=first; store.points[1]=second;
  const parsed=parseCsvText(csv);
  ribbonTab='data'; ribbonOpen=true; renderRibbon();
  return {
    csv, rows, X0:csvNum(X0), Y0:csvNum(Y0), Z0:csvNum(p0.z||0), rawName:p0.name, no:p0.no,
    orderedIds:ordered.slice(0,2).map(p=>p.id), wantIds:[p0.id,p1.id],
    count:ordered.length, refCount:store.refPoints.length,
    parsed:parsed.pts.slice(0,2),
    hasButton:document.getElementById('ribbonCmd').textContent.includes('復元点CSV')
  };
});
eq('CSVは10列', csvOut.rows[0].length, 10);
eq('CSVの1列目は点番', csvOut.rows[0][0], csvOut.no);
eq('CSVの2列目は元の点名', csvOut.rows[0][1], csvOut.rawName);
ok('CSV点名に表示用略称を付けない', !csvOut.rows[0][1].endsWith('L'), csvOut.rows[0][1]);
eq('CSVの3列目はX', csvOut.rows[0][2], csvOut.X0);
eq('CSVの4列目はY', csvOut.rows[0][3], csvOut.Y0);
eq('CSVの5列目はZ', csvOut.rows[0][4], csvOut.Z0);
eq('CSVの6列目は固定マーク', csvOut.rows[0][5], '12,1.0,1,1');
ok('固定マークを1列として引用', csvOut.csv.includes('"12,1.0,1,1"'), csvOut.csv.slice(0,120));
eq('CSVの7列目はアルミプレート', csvOut.rows[0][6], 'アルミプレート');
eq('ペンキもCSVへ出る', csvOut.rows[1][6], 'ペンキ');
eq('CSVの8列目点種は空欄', csvOut.rows[0][7], '');
eq('CSVの9列目リンクは空欄', csvOut.rows[0][8], '');
eq('既設点だけ10列目へ既設点', csvOut.rows[0][9], '既設点');
eq('打設点の備考は空欄', csvOut.rows[1][9], '');
eq('SIMAの取込順に並べ直す', csvOut.orderedIds.join('/'), csvOut.wantIds.join('/'));
eq('CSV出力は境界点だけ', csvOut.count, 2397);
ok('基準点はCSV件数に含めない', csvOut.refCount>0 && csvOut.count!==csvOut.refCount*2, csvOut);
eq('10列CSVを再取込すると点番を保持', csvOut.parsed[0].no, csvOut.no);
eq('10列CSVを再取込すると点名を保持', csvOut.parsed[0].name, csvOut.rawName);
eq('10列CSVを再取込すると杭種を保持', csvOut.parsed[0].stake, 'アルミプレート');
ok('データタブに復元点CSVボタンがある', csvOut.hasButton);
/* ヘッドレスChromiumは blob ダウンロードの download 属性を suggestedFilename() に載せない。
   ダウンロードが実際に起きたことは download イベントで、保存名は渡した値で確かめる。 */
const csvDownloadWait = page2.waitForEvent('download');
const csvName = await page2.evaluate(() => {
  let got = null;
  const org = window.download;
  window.download = (blob, name) => { got = name; return org(blob, name); };
  try { exportRestorationCsv(); } finally { window.download = org; }
  return got;
});
const csvDownload = await csvDownloadWait;
ok('CSVファイルを実際にダウンロードできる', !!csvDownload, String(csvDownload));
ok('CSVの保存名が日付つき', /^境界復元_復元点_\d{4}-\d{2}-\d{2}\.csv$/.test(csvName || ''), csvName);
ok('ダウンロードしたCSVは空ではない', readFileSync(await csvDownload.path()).length > 100, await csvDownload.path());

/* ---------- 20. レイヤ ---------- */
const layers = await page2.evaluate(() => {
  openLayers();
  const html = document.getElementById('layerPanel').textContent;
  const rows = Array.from(document.querySelectorAll('#otherLayers .listRow span:nth-child(2)')).map(e => e.textContent.trim());
  return { html, rows, now: document.getElementById('layerNow').textContent };
});
for (const lb of ['境界点', '画地の線', '計測線', '距離', '基準点', '手書きメモ', '背景地図']) {
  ok(`レイヤに「${lb}」がある`, layers.html.includes(lb));
}
ok('状態でしぼる欄がある', layers.html.includes('状態でしぼる'));
ok('圏外そなえがレイヤの中にある', layers.html.includes('この範囲を圏外用に控える'));

/* ---------- 21. 設定 ---------- */
const conf = await page2.evaluate(() => {
  openSettings();
  document.getElementById('setThinPt').value = '77';
  document.getElementById('setThinName').value = '33';
  document.getElementById('setThinDist').value = '55';
  document.getElementById('setWorker').value = '山田';
  saveSettings();
  return { pt: store.settings.thinPt, nm: store.settings.thinName,
           ds: store.settings.thinDist, w: store.settings.worker,
           zones: document.getElementById('setZone').options.length };
});
eq('点の上限を変えられる', conf.pt, 77);
eq('点名の上限を変えられる', conf.nm, 33);
eq('距離の閾値を変えられる', conf.ds, 55);
eq('作業者名を変えられる', conf.w, '山田');
eq('系番号は19系まで選べる', conf.zones, 19);

/* ---------- 21b. 点名が "A01" のCSVをSIMAと間違えない ---------- */
const csvGuard = await page2.evaluate(() => {
  const csv = [
    'A00,-39525.623,60295.494,0,,木杭',
    'A01,-39520.000,60290.000,12.5,3,木杭',
    'G00,-39510.000,60280.000,0,,金属鋲',
    'Z00,-39500.000,60270.000,0,,石杭',
    'ふつうの点,-39490.000,60260.000,0,,不明'
  ].join('\r\n');
  const sima = 'G00,04,テスト,\r\nZ00, /* 座標データ */,\r\nA00,\r\nA01,    1,P1      , -100.000,  200.000,,\r\nA99,';
  const rows = parseCsvText(csv).pts;
  return {
    csvIsSima: looksSima(csv),
    simaIsSima: looksSima(sima),
    n: rows.length,
    names: rows.map(r => r.name),
    x0: rows[0].X, y0: rows[0].Y,
    simaN: parseSimaFull(sima).pts.length,
  };
});
eq('点名が構造コードと同じCSVをSIMAと間違えない', csvGuard.csvIsSima, false);
eq('本物のSIMAはSIMAと分かる', csvGuard.simaIsSima, true);
eq('CSVの5点が全部読める', csvGuard.n, 5);
eq('点名がそのまま残る', csvGuard.names.join(','), 'A00,A01,G00,Z00,ふつうの点');
near('1点目のX', csvGuard.x0, -39525.623, 1e-9);
near('1点目のY', csvGuard.y0, 60295.494, 1e-9);
eq('SIMAは今までどおり読める', csvGuard.simaN, 1);

/* ---------- 21c. 画地の頂点が欠けても辺長がずれない ---------- */
const gap = await page2.evaluate(() => {
  /* P3 の座標が無いSIMA。画地は P1→P2→P3→P4→P1 を参照する */
  const L = [
    'G00,04,欠けたテスト,', 'Z00, /* 座標データ */,', 'A00,',
    'A01,    1,P1                  ,    0.000,    0.000,,',
    'A01,    2,P2                  ,   10.000,    0.000,,',
    'A01,    4,P4                  ,   10.000,   10.000,,',
    'A99,', 'Z00, /* 画地データ */,', 'D00,    1,欠け画地  ,1,',
    'B01,    1,P1                  ,', 'C03,   10.000,0.0000,',
    'B01,    2,P2                  ,', 'C03,    7.000,90.0000,',   // P2→P3（P3は座標なし）
    'B01,    3,P3                  ,', 'C03,    5.000,180.0000,',  // P3→P4
    'B01,    4,P4                  ,', 'C03,   14.142,225.0000,',  // P4→P1（閉じる辺）
    'D99,'
  ].join('\r\n');
  pendingImport = { file: { name: '欠け.sim' }, parsed: parseSimaFull(L), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '欠けテスト';
  const before = store.lines.length;
  commitImport();
  const l = store.lines[store.lines.length - 1];
  const idx = ptIndex();
  const names = l.ptIds.map(id => { const p = idx.get(id); return p ? p.name : null; });
  const seg = lineSegments(l);
  /* 実際に描かれる辺と、そこに出る距離を集める */
  const drawn = [];
  const m = l.ptIds.length, segs = l.closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const a = idx.get(l.ptIds[i]), b = idx.get(l.ptIds[(i + 1) % m]);
    if (!a || !b) continue;
    drawn.push({ from: a.name, to: b.name, shown: l.dists[i], truth: distBetween(a, b) });
  }
  return { before, after: store.lines.length, names, lost: l.lost, closed: l.closed,
           nSeg: seg.n, total: seg.total, drawn, len: l.ptIds.length };
});
eq('欠けた画地も取り込む', gap.after, gap.before + 1);
eq('頂点の並びは詰めずに保つ', gap.len, 4);
eq('欠けた頂点はnullで残る', gap.names.join(','), 'P1,P2,,P4');
eq('欠けた頂点の数を覚えている', gap.lost, 1);
eq('引ける辺は2本だけ', gap.nSeg, 2);
eq('引く辺は P1→P2 と P4→P1', gap.drawn.map(d => d.from + '→' + d.to).join(','), 'P1→P2,P4→P1');
ok('出る距離が実際の辺と一致する', gap.drawn.every(d => Math.abs(d.shown - d.truth) < 0.001), gap.drawn);
near('延長は引けた辺だけの合計', gap.total, 10 + 14.142, 1e-9);
eq('閉じた線として扱う', gap.closed, true);

/* ---------- 21d. 取込を消したあと［取消］で幽霊の計測線が出ない ---------- */
const ghost = await page2.evaluate(() => {
  const org = window.confirm; window.confirm = () => true;
  const imp = store.imports.find(i => i.kind !== 'ref' && pointsOf(i.id).length > 3);
  const pts = pointsOf(imp.id);
  state.currentRoute = [pts[0].id, pts[1].id]; commitRoute();
  state.currentRoute = [pts[1].id, pts[2].id]; commitRoute();
  const madeRoutes = store.routes.length;
  const undoDepth = rtUndo.length;
  delImport(imp.id);
  const afterDel = { routes: store.routes.length, rtUndo: rtUndo.length, recUndo: recUndo.length };
  undoRoute();
  const idx = ptIndex();
  const dangling = store.routes.filter(r => (r.ptIds || []).some(id => !idx.get(id))).length;
  window.confirm = org;
  return { madeRoutes, undoDepth, afterDel, routes: store.routes.length, dangling };
});
ok('計測線を2本引けた', ghost.madeRoutes >= 2, ghost);
ok('取消の履歴が積まれていた', ghost.undoDepth >= 2, ghost);
eq('取込を消すと計測線も消える', ghost.afterDel.routes, 0);
eq('取消の履歴も捨てる', ghost.afterDel.rtUndo, 0);
eq('記録の履歴も捨てる', ghost.afterDel.recUndo, 0);
eq('［取消］を押しても計測線は戻らない', ghost.routes, 0);
eq('どこにも無い点を指す計測線は残らない', ghost.dangling, 0);

/* ---------- 21e. まとめ方のキーに ' が入っても開閉できる ---------- */
const quote = await page2.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: "O'Brien の一覧図.sim" }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = "O'Brien 地区";
  commitImport();
  stakeList().push("O'Brien杭");
  setRec(store.points[0].id, 'da', "O'Brien杭");
  openList('pt');
  setPtGroup('stake'); ptCloseAll();
  const html = document.getElementById('pointList').innerHTML;
  const btn = document.querySelector('#pointList button');
  btn.click();
  const openedNow = document.getElementById('pointList').innerHTML;
  const key = ptGroupKeysNow[0];
  return { hasKey: html.includes("O&quot;") === false, key,
           opened: ptOpen.has(key), rows: openedNow.match(/class="listRow"/g)?.length || 0,
           impName: store.imports[store.imports.length - 1].name };
}, simBytes);
eq('呼び名の ' + "'" + ' はそのまま残る', quote.impName, "O'Brien 地区");
ok('まとめ方のキーが取れる', typeof quote.key === 'string', quote);
eq('見出しを押すと開く', quote.opened, true);
ok('中身が出る', quote.rows > 0, quote);

/* ---------- 21f. 年代別写真の限界の案内 ---------- */
const zhint = await page2.evaluate(() => {
  const out = {};
  fitToPoint(store.points[0].id);
  const read = () => document.getElementById('fixBar').textContent;
  setBaseMap('ort_USA10');
  state.view.scale = 8;     draw(); out.tooNear = read();  out.zNear = wantedTileZoom();
  state.view.scale = 0.002; draw(); out.tooFar  = read();  out.zFar  = wantedTileZoom();
  state.view.scale = 0.06;  draw(); out.justOk  = read();  out.zOk   = wantedTileZoom();
  setBaseMap('std');
  state.view.scale = 0.06;  draw(); out.stdOk   = read();
  return out;
});
ok('拡大しすぎの判定になる段', zhint.zNear > 17, zhint.zNear);
ok('縮小しすぎの判定になる段', zhint.zFar < 10, zhint.zFar);
ok('ちょうどよい段', zhint.zOk >= 10 && zhint.zOk <= 17, zhint.zOk);
ok('拡大しすぎると「これ以上は細かくなりません」と出る', zhint.tooNear.includes('これ以上は細かくなりません'), zhint.tooNear);
ok('縮小しすぎると「もっと拡大」と出る', zhint.tooFar.includes('もっと拡大すると出ます'), zhint.tooFar);
ok('ちょうどよい範囲では出ない', !zhint.justOk.includes('これ以上') && !zhint.justOk.includes('もっと拡大'), zhint.justOk);
ok('標準地図でも同じ範囲なら出ない', !zhint.stdOk.includes('これ以上') && !zhint.stdOk.includes('もっと拡大'), zhint.stdOk);

/* ---------- 21g. 画地名（地番）の表示 ---------- */
const plotLbl = await page2.evaluate(bytes => {
  /* 前のテストで足し引きした分を消し、サンプルだけの状態にしてから確かめる */
  store.points = []; store.refPoints = []; store.lines = [];
  store.routes = []; store.imports = []; store.layers.hiddenImports = [];
  invalidatePtMap(); invalidatePlotMap();
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: '画地サンプル.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '画地サンプル';
  commitImport();

  /* 描いた画地名を横取りして数える */
  const org = window.drawPlotName;
  let got = [];
  window.drawPlotName = (cx, cy, text, px) => { got.push({ cx, cy, text, px }); };
  const run = () => { got = []; draw(); return got.slice(); };

  const out = {};
  out.lines = store.lines.length;
  out.layerOn = store.layers.plotName !== false;

  const idx = ptIndex();
  /* テスト側で作り直す判定。アプリとは別に書いて突き合わせる。
     screenEdges … その画地の線を画面座標で全部集める
     inside      … 右へ引いた半直線が線と何回交わるかで、内側かどうかを見る（偶奇） */
  const screenEdges = l => {
    const ids = l.ptIds, n = ids.length, segs = l.closed ? n : n - 1, E = [];
    for (let i = 0; i < segs; i++) {
      const a = idx.get(ids[i]), b = idx.get(ids[(i + 1) % n]);
      if (!a || !b) continue;
      E.push([toScr(a.x, a.y), toScr(b.x, b.y)]);
    }
    return E;
  };
  const inside = (E, x, y) => {
    let c = 0;
    for (const [A, B] of E) {
      if ((A[1] <= y) === (B[1] <= y)) continue;
      if (x < A[0] + (B[0] - A[0]) * (y - A[1]) / (B[1] - A[1])) c++;
    }
    return (c & 1) === 1;
  };
  const distToLine = (E, x, y) => {
    let best = 1e9;
    for (const [A, B] of E) {
      const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - A[0]) * dx + (y - A[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (A[0] + t * dx), y - (A[1] + t * dy)));
    }
    return best;
  };
  const lineOf = t => store.lines.find(x => (String(x.name).trim() || ('画地' + x.no)) === t);

  // 1) 全体表示 … 4画地すべてに、その画地の「囲まれた中」へ出る
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  const wide = run();
  out.wideN = wide.length;
  out.wideNames = wide.map(g => g.text).sort();
  out.wideOnScreen = wide.every(g => g.cx >= 0 && g.cx <= W && g.cy >= 0 && g.cy <= H);
  out.wideInside = wide.filter(g => {
    const l = lineOf(g.text);
    return l && inside(screenEdges(l), g.cx, g.cy);
  }).length;
  /* 線のちょうど上ではなく、線から離れた中にあること */
  out.wideOffLine = wide.every(g => {
    const l = lineOf(g.text);
    return l && distToLine(screenEdges(l), g.cx, g.cy) > 1;
  });

  // 2) 拡大 … 画地の真ん中は画面の外でも、見えている内側に出る
  const target = store.lines.find(l => l.name === '加津佐西部圃場整備');
  fitToLine(target.id);
  state.view.scale *= 9;
  const near = run();
  out.nearN = near.length;
  const mine = near.find(g => g.text === target.name);
  out.nearHas = !!mine;
  out.nearOnScreen = !!mine && mine.cx >= 0 && mine.cx <= W && mine.cy >= 0 && mine.cy <= H;
  {
    const E = screenEdges(target);
    let sx = 0, sy = 0, k = 0, allIn = true;
    for (const [A, B] of E) {
      sx += A[0]; sy += A[1]; k++;
      if (A[0] < 0 || A[0] > W || A[1] < 0 || A[1] > H) allIn = false;
      if (B[0] < 0 || B[0] > W || B[1] < 0 || B[1] > H) allIn = false;
    }
    out.allIn = allIn;
    const ctr = [sx / k, sy / k];
    out.centreOffScreen = !(ctr[0] >= 0 && ctr[0] <= W && ctr[1] >= 0 && ctr[1] <= H);
    out.nearInside = !!mine && inside(E, mine.cx, mine.cy);
    out.nearDistToLine = mine ? distToLine(E, mine.cx, mine.cy) : -1;
  }

  // 3) レイヤを消すと出ない
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  store.layers.plotName = false;
  out.offN = run().length;
  store.layers.plotName = true;
  out.backN = run().length;

  // 4) 名前が空なら「画地N」
  const save0 = target.name;
  target.name = '   ';
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  out.blank = run().map(g => g.text);
  target.name = save0;

  window.drawPlotName = org;
  draw();
  return out;
}, simBytes);
eq('取り込み直して画地は4件', plotLbl.lines, 4);
eq('画地名レイヤは既定で表示', plotLbl.layerOn, true);
eq('全体表示で4画地すべてに出る', plotLbl.wideN, 4);
eq('出る名前はD00の区画名', plotLbl.wideNames.join(','), '加津佐津波見圃場整備,加津佐西部圃場整備,野田第４,野田第５');
eq('全体表示のラベルは画面の中', plotLbl.wideOnScreen, true);
eq('全体表示では画地線で囲まれた中に置く', plotLbl.wideInside, 4);
ok('全体表示のラベルは線の上に乗っていない', plotLbl.wideOffLine, plotLbl.wideOffLine);
eq('拡大しても画地名が出る', plotLbl.nearHas, true);
eq('拡大時のラベルも画面の中', plotLbl.nearOnScreen, true);
eq('拡大時は画地の一部しか見えていない', plotLbl.allIn, false);
eq('拡大時は真ん中が画面の外', plotLbl.centreOffScreen, true);
eq('拡大時も画地線で囲まれた中に置く', plotLbl.nearInside, true);
ok('拡大時のラベルは線の上に乗っていない', plotLbl.nearDistToLine > 1, plotLbl.nearDistToLine);
eq('レイヤを消すと出ない', plotLbl.offN, 0);
eq('戻すとまた出る', plotLbl.backN, 4);
ok('名前が空なら画地番号で出す', plotLbl.blank.some(t => /^画地\d+$/.test(t)), plotLbl.blank);
const plotDisp = await page2.evaluate(() => {
  openDispLine();
  const html = document.getElementById('dispPanel').textContent;
  setDisp('plotNameColor', '#112233');
  setDisp('plotNameSize', 'xl');
  const v = { c: disp('plotNameColor'), s: disp('plotNameSize') };
  resetDisp();
  closePanel('dispPanel');
  return { html, v, back: disp('plotNameColor') };
});
ok('線の表示設定に画地名の色がある', plotDisp.html.includes('画地名（地番）の色'), plotDisp.html.slice(0, 120));
ok('線の表示設定に画地名の大きさがある', plotDisp.html.includes('画地名（地番）の大きさ'));
eq('画地名の色を変えられる', plotDisp.v.c, '#112233');
eq('画地名の大きさを変えられる', plotDisp.v.s, 'xl');
eq('初期値に戻せる', plotDisp.back, '#3d2680');
const plotLayerUi = await page2.evaluate(() => {
  openLayers();
  const t = document.getElementById('layerPanel').textContent;
  closePanel('layerPanel');
  return t;
});
ok('レイヤ画面に画地名（地番）がある', plotLayerUi.includes('画地名（地番）'));

/* ---------- 21h. 地番名を取込ファイルごとに切り替える ---------- */
const plotPerFile = await page2.evaluate(bytes => {
  store.points = []; store.refPoints = []; store.lines = [];
  store.routes = []; store.imports = [];
  store.layers.hiddenImports = []; store.layers.hiddenPlotNames = [];
  invalidatePtMap(); invalidatePlotMap();
  const txt = decodeText(new Uint8Array(bytes).buffer);
  const load = nm => {
    pendingImport = { file: { name: nm + '.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
    importKind = 'bp';
    document.getElementById('impName').value = nm;
    commitImport();
    return store.imports[store.imports.length - 1].id;
  };
  const a = load('図面A'), b = load('図面B');
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  const org = window.drawPlotName;
  let got = [];
  window.drawPlotName = (cx, cy, t) => { got.push(t); };
  const run = () => { got = []; draw(); return got.length; };

  const out = { imports: store.imports.length, lines: store.lines.length };
  const eligible = () => store.lines.filter(isPlotNameVisible).length;
  out.bothEligible = eligible();
  out.both = run();
  store.layers.hiddenPlotNames = [a];
  out.hideAEligible = eligible();
  out.hideA = run();
  out.aLinesHidden = store.lines.filter(l => l.impId === a).every(l => !isPlotNameVisible(l));
  out.bStillOn = store.lines.filter(l => l.impId === b).every(l => isPlotNameVisible(l));
  // 線そのものは消えない
  out.aLineStillDrawn = store.lines.filter(l => l.impId === a).every(l => isLineVisible(l));
  // 取込ファイルごと非表示にすれば地番名も出ない
  store.layers.hiddenPlotNames = [];
  store.layers.hiddenImports = [b];
  out.hideFileB = run();
  store.layers.hiddenImports = [];
  // 全体スイッチを切るとどれも出ない
  store.layers.plotName = false;
  out.masterOff = run();
  store.layers.plotName = true;
  out.backOnEligible = eligible();
  out.backOn = run();
  // 画地を持つファイルだけが切替の対象
  out.withLines = importsWithLines().length;
  importKind = 'ref';
  pendingImport = { file: { name: '基準点.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  document.getElementById('impName').value = '基準点';
  commitImport();
  out.withLinesAfterRef = importsWithLines().length;
  out.importsAfterRef = store.imports.length;

  window.drawPlotName = org;
  openLayers();
  out.panel = document.getElementById('plotNameLayers').textContent;
  closePanel('layerPanel');
  draw();
  return out;
}, simBytes);
eq('2ファイル取り込んだ', plotPerFile.imports, 2);
eq('画地は8件', plotPerFile.lines, 8);
eq('どちらも出ているときは8画地ぶんが対象', plotPerFile.bothEligible, 8);
ok('地図にも出ている', plotPerFile.both > 0, plotPerFile.both);
eq('片方を消すと対象は4画地', plotPerFile.hideAEligible, 4);
eq('地図に出る数も4件になる', plotPerFile.hideA, 4);
eq('消した側の地番名は出ない', plotPerFile.aLinesHidden, true);
eq('もう片方は出たまま', plotPerFile.bStillOn, true);
eq('地番名を消しても画地の線は残る', plotPerFile.aLineStillDrawn, true);
eq('ファイルごと非表示なら地番名も出ない', plotPerFile.hideFileB, 4);
eq('全体スイッチを切るとどれも出ない', plotPerFile.masterOff, 0);
eq('戻すと対象は8画地に戻る', plotPerFile.backOnEligible, 8);
ok('地図にもまた出る', plotPerFile.backOn >= plotPerFile.hideA, plotPerFile.backOn);
eq('切替の対象は画地を持つファイルだけ', plotPerFile.withLines, 2);
eq('基準点を足しても切替の対象は増えない', plotPerFile.withLinesAfterRef, 2);
eq('取込ファイル自体は3件になる', plotPerFile.importsAfterRef, 3);
ok('レイヤ画面の地番名の節に2ファイル出る',
   plotPerFile.panel.includes('図面A') && plotPerFile.panel.includes('図面B'), plotPerFile.panel.slice(0, 120));
ok('地番名の節に基準点は出ない', !plotPerFile.panel.includes('基準点'), plotPerFile.panel.slice(0, 160));

/* ---------- 21i. 現場（プロジェクト）別保存 ---------- */
const siteBasics = await page2.evaluate(async bytes => {
  const out = {};
  out.startSites = siteList().length;
  out.startName = activeSiteName();
  out.max = siteMax();
  const first = sites.active;

  // いまの現場に中身がある状態から、新しい現場を作る
  const before = progCounts().all;
  out.before = before;
  const rec = await createSite('第二現場');
  out.made = !!rec && rec.name === '第二現場';
  out.sitesNow = siteList().length;
  out.emptyAfterCreate = { pts: store.points.length, lines: store.lines.length,
                           routes: store.routes.length, imports: store.imports.length };
  out.activeIsNew = sites.active === rec.id;

  // 新しい現場へ取り込む
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: 'b.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '第二現場データ';
  commitImport();
  setRec(store.points[0].id, 'ki', '金属鋲');
  savePending = true; await flushSave();
  out.secondPts = store.points.length;
  out.secondDone = progCounts().done;

  // 元の現場へ戻すと、元の中身がそのまま出る
  await switchSite(first);
  out.backPts = store.points.length;
  out.backName = activeSiteName();
  out.backImports = store.imports.map(i => i.name);

  // もう一度、第二現場へ
  await switchSite(rec.id);
  out.againPts = store.points.length;
  out.againDone = progCounts().done;
  out.againImports = store.imports.map(i => i.name);

  // 目録に点数が入っている
  out.meta = siteList().map(x => ({ name: x.name, pts: x.pts, done: x.done }));
  return out;
}, simBytes);
eq('はじめは1現場', siteBasics.startSites, 1);
eq('その名前は現場１', siteBasics.startName, '現場１');
eq('上限の初期値は5件', siteBasics.max, 5);
eq('新しい現場を作れる', siteBasics.made, true);
eq('2現場になる', siteBasics.sitesNow, 2);
eq('作った現場は空', siteBasics.emptyAfterCreate.pts, 0);
eq('作った現場に画地も無い', siteBasics.emptyAfterCreate.lines, 0);
eq('作った現場に取込ファイルも無い', siteBasics.emptyAfterCreate.imports, 0);
eq('作った現場が開く', siteBasics.activeIsNew, true);
eq('第二現場に取り込める', siteBasics.secondPts, 2397);
eq('第二現場の記録は1点', siteBasics.secondDone, 1);
eq('元の現場へ戻すと元の点が出る', siteBasics.backPts, siteBasics.before);
eq('元の現場の名前', siteBasics.backName, '現場１');
ok('元の現場の取込ファイルが残っている',
   siteBasics.backImports.includes('図面A'), siteBasics.backImports);
eq('第二現場へ戻すと点も戻る', siteBasics.againPts, 2397);
eq('第二現場の記録も戻る', siteBasics.againDone, 1);
eq('第二現場の取込ファイル', siteBasics.againImports.join(','), '第二現場データ');
ok('目録に点数が入る', siteBasics.meta.every(m => m.pts > 0), siteBasics.meta);

/* 現場ごと・端末共通の切り分け */
const siteSplit = await page2.evaluate(async () => {
  const out = {};
  const ids = siteList().map(x => x.id);
  await switchSite(ids[0]);
  store.settings.worker = '端末の作業者';
  store.settings.zone = 1;
  setDisp('lineColor', '#111111');
  store.settings.thinDist = 33;
  savePending = true; await flushSave();

  await switchSite(ids[1]);
  out.workerKept = store.settings.worker;      // 端末共通 → 引き継ぐ
  out.thinKept = store.settings.thinDist;      // 端末共通 → 引き継ぐ
  out.dispHere = disp('lineColor');            // 現場ごと → 既定に戻る
  store.settings.zone = 9;
  setDisp('lineColor', '#992200');
  savePending = true; await flushSave();

  await switchSite(ids[0]);
  out.zone0 = store.settings.zone;
  out.disp0 = disp('lineColor');
  await switchSite(ids[1]);
  out.zone1 = store.settings.zone;
  out.disp1 = disp('lineColor');
  return out;
});
eq('作業者名は端末で共通', siteSplit.workerKept, '端末の作業者');
eq('間引きの数値も端末で共通', siteSplit.thinKept, 33);
eq('表示設定は現場ごと（新しい現場は既定）', siteSplit.dispHere, '#5a3ea8');
eq('座標系は現場ごと（1系）', siteSplit.zone0, 1);
eq('座標系は現場ごと（9系）', siteSplit.zone1, 9);
eq('表示設定は現場ごと（現場1）', siteSplit.disp0, '#111111');
eq('表示設定は現場ごと（現場2）', siteSplit.disp1, '#992200');

/* 上限・名前変更・削除 */
const siteLimit = await page2.evaluate(async () => {
  const out = {};
  const org = window.alert, orgC = window.confirm;
  let said = '';
  window.alert = m => { said = String(m); };
  window.confirm = () => true;
  while (siteList().length < siteMax()) await createSite('');
  out.atMax = siteList().length;
  const over = await createSite('はみ出し');
  out.overIsNull = over === null;
  out.saidMax = said.includes('5件までです');
  out.stillMax = siteList().length;

  // 上限より小さくは設定できない
  openSettings();
  document.getElementById('setSiteMax').value = '2';
  saveSettings();
  out.maxAfterTryLower = siteMax();

  // 上限を増やせば作れる
  openSettings();
  document.getElementById('setSiteMax').value = '7';
  saveSettings();
  out.maxUp = siteMax();
  const more = await createSite('6件目');
  out.madeSixth = !!more;

  // 名前を変える
  await renameSite(sites.active, '名前を変えた現場');
  out.renamed = activeSiteName();

  // 削除
  const victim = siteList().find(x => x.id !== sites.active);
  const n0 = siteList().length;
  await removeSite(victim.id);
  out.afterDelete = siteList().length;
  out.deletedGone = !siteById(victim.id);
  out.stillOpen = activeSiteName();

  // いま開いている現場を消すと、別の現場が開く
  const cur = sites.active;
  await removeSite(cur);
  out.afterDeleteActive = siteList().length;
  out.movedOn = sites.active !== cur;
  out.n0 = n0;
  window.alert = org; window.confirm = orgC;
  return out;
});
eq('5件で満杯になる', siteLimit.atMax, 5);
eq('6件目は作れない', siteLimit.overIsNull, true);
ok('上限だと知らせる', siteLimit.saidMax, siteLimit.saidMax);
eq('件数は増えない', siteLimit.stillMax, 5);
eq('いまの件数より小さい上限は入らない', siteLimit.maxAfterTryLower, 5);
eq('上限を7件に増やせる', siteLimit.maxUp, 7);
eq('増やせば作れる', siteLimit.madeSixth, true);
eq('名前を変えられる', siteLimit.renamed, '名前を変えた現場');
eq('削除で1件減る', siteLimit.afterDelete, 5);
eq('消えている', siteLimit.deletedGone, true);
eq('開いている現場は変わらない', siteLimit.stillOpen, '名前を変えた現場');
eq('開いている現場を消すと別の現場へ移る', siteLimit.movedOn, true);
eq('さらに1件減る', siteLimit.afterDeleteActive, 4);

/* 自動控えは現場ごと */
const siteSnaps = await page2.evaluate(async () => {
  /* 別の現場でも1件控えを作ってから確かめる */
  const here = sites.active;
  const other = siteList().find(x => x.id !== here);
  if (other) {
    await switchSite(other.id);
    await pushSnapshot(snapshotJson());
    await switchSite(here);
  }
  const all = await idbReq('snapshots', 'readonly', s => s.getAll());
  const mine = all.filter(r => (r.siteId || '') === (sites.active || ''));
  const others = all.filter(r => r.siteId && r.siteId !== sites.active);
  const orphan = all.filter(r => !r.siteId);
  await openSnapshots();
  const shown = document.querySelectorAll('#snapList .menuItem').length;
  closePanel('snapPanel');
  return { total: all.length, mine: mine.length, others: others.length,
           orphan: orphan.length, shown };
});
eq('控えには現場が付く', siteSnaps.orphan, 0);
ok('他の現場の控えも残っている', siteSnaps.others > 0, siteSnaps);
eq('画面に出るのはいまの現場のぶんだけ', siteSnaps.shown, siteSnaps.mine);

/* この現場を空にする / 全現場を消す */
const siteClear = await page2.evaluate(async bytes => {
  const orgC = window.confirm; window.confirm = () => true;
  const out = {};
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: 'c.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '消す前';
  commitImport();
  const keeper = siteList().find(x => x.id !== sites.active);
  const keeperPts = keeper.pts;
  out.n0 = siteList().length;
  await clearSite();
  out.emptied = { pts: store.points.length, lines: store.lines.length, imports: store.imports.length };
  out.sitesKept = siteList().length;
  out.otherKept = siteById(keeper.id).pts === keeperPts;
  out.workerKept = store.settings.worker;

  await clearAllSites();
  out.afterAll = siteList().length;
  out.afterAllName = activeSiteName();
  out.afterAllPts = store.points.length;
  out.workerAfterAll = store.settings.worker;   // 端末の設定は残る
  const snaps = await idbReq('snapshots', 'readonly', s => s.getAll());
  out.snapsAfterAll = snaps.length;
  window.confirm = orgC;
  return out;
}, simBytes);
eq('空にしても現場の数は変わらない', siteClear.sitesKept, siteClear.n0);
eq('中身は空になる', siteClear.emptied.pts, 0);
eq('画地も消える', siteClear.emptied.lines, 0);
eq('取込ファイルも消える', siteClear.emptied.imports, 0);
eq('他の現場は無事', siteClear.otherKept, true);
eq('作業者名は残る', siteClear.workerKept, '端末の作業者');
eq('全現場を消すと1件になる', siteClear.afterAll, 1);
eq('その名前は現場１', siteClear.afterAllName, '現場１');
eq('中身は空', siteClear.afterAllPts, 0);
eq('端末の設定は残る', siteClear.workerAfterAll, '端末の作業者');
eq('自動控えも消える', siteClear.snapsAfterAll, 0);

/* ---------- 21j. IDが重ならないこと ----------
   数千点を一度に作るので、IDが1件でも重なると画地の辺や記録が別の点に付いてしまう。 */
const idUniq = await page2.evaluate(bytes => {
  store.points = []; store.refPoints = []; store.lines = [];
  store.routes = []; store.imports = [];
  invalidatePtMap(); invalidatePlotMap();
  const txt = decodeText(new Uint8Array(bytes).buffer);
  for (const [nm, kind] of [['A', 'bp'], ['B', 'bp'], ['C', 'ref']]) {
    pendingImport = { file: { name: nm + '.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
    importKind = kind;
    document.getElementById('impName').value = nm;
    commitImport();
  }
  const all = [...store.points, ...store.refPoints].map(p => p.id)
    .concat(store.lines.map(l => l.id), store.imports.map(i => i.id));
  const uniq = new Set(all);
  /* 画地の辺が、その画地自身の点を指しているか（IDが重なるとここが崩れる） */
  const idx = ptIndex();
  let wrong = 0;
  for (const l of store.lines) {
    for (const id of l.ptIds) {
      if (!id) continue;
      const p = idx.get(id);
      if (!p || p.impId !== l.impId) wrong++;
    }
  }
  /* 辺長も引き続き一致するか */
  let worst = 0;
  for (const l of store.lines) {
    const ids = l.ptIds, n = ids.length, segs = l.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = idx.get(ids[i]), b = idx.get(ids[(i + 1) % n]);
      if (!a || !b || !isFinite(l.dists[i])) continue;
      worst = Math.max(worst, Math.abs(distBetween(a, b) - l.dists[i]));
    }
  }
  /* 生成そのものも確かめる */
  const made = new Set();
  for (let i = 0; i < 20000; i++) made.add(newId());
  return { total: all.length, uniq: uniq.size, wrong, worst, made: made.size };
}, simBytes);
eq('3ファイルぶんのIDを作った', idUniq.total, 2397 * 2 + 2397 + 8 + 3);
eq('IDが1件も重ならない', idUniq.uniq, idUniq.total);
eq('画地の辺は自分のファイルの点を指す', idUniq.wrong, 0);
ok('辺長も一致したまま', idUniq.worst < 0.001, idUniq.worst);
eq('2万件つくっても重ならない', idUniq.made, 20000);

/* ---------- 22. 描画がエラーなく回る ---------- */
const drawOk = await page2.evaluate(() => {
  store.settings.thinPt = 300; store.settings.thinName = 150; store.settings.thinDist = 40;
  const scales = [0.05, 0.5, 2, 10, 60, 300];
  for (const s of scales) { state.view.scale = s; draw(); }
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  draw();
  return true;
});
ok('いろいろな倍率で描いてもエラーが出ない', drawOk && errors2.length === 0, errors2.slice(0, 3));

/* ---------- 23. 出典の表示 ---------- */
const credit = await page2.evaluate(() => {
  const r = creditBox();
  return { x: r.x, y: r.y, w: r.w, h: r.h, W, H };
});
ok('出典は画面の中に収まる', credit.x > 0 && credit.y > 0 && credit.x + credit.w <= credit.W, credit);

/* ---------- 24. 選点地図版の保存データと混ざらない ---------- */
const isolateCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const isolate = await isolateCtx.newPage();
await isolate.goto(BASE.replace('fukugen-map.html','seed-not-found.html'));
await isolate.evaluate(() => new Promise((resolve,reject) => {
  const rq=indexedDB.open('sentenApp',3);
  rq.onupgradeneeded=()=>{
    const db=rq.result;
    if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if(!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots',{keyPath:'id'});
    if(!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
    if(!db.objectStoreNames.contains('tilemeta')) db.createObjectStore('tilemeta');
  };
  rq.onerror=()=>reject(rq.error);
  rq.onsuccess=()=>{
    const db=rq.result, tx=db.transaction('kv','readwrite');
    const selectionData={
      points:[{id:'selection-point',name:'選点版の点',x:1,y:2}], routes:[], imports:[], refPoints:[], strokes:[],
      settings:{stakes:[{id:'co',name:'コンクリート杭'}],stakesVer:2}, layers:{}, disp:{}
    };
    tx.objectStore('kv').put(JSON.stringify(selectionData),'store');
    tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>reject(tx.error);
  };
}));
await isolate.goto(BASE);
await isolate.waitForFunction(() => typeof draw === 'function' && typeof store === 'object');
const isolated = await isolate.evaluate(() => ({
  db:DB_NAME, points:store.points.length, stakes:stakeList().slice(), appId:store.appId
}));
eq('選点版DBがあっても専用DBを使う', isolated.db, 'kyokaiFukugenMap');
eq('選点版の点を読み込まない', isolated.points, 0);
eq('選点版の杭種オブジェクトを読み込まない', isolated.stakes.join('/'), 'コンクリート杭/プラスチック杭/金属鋲/金属標/アルミプレート/ペンキ');
eq('境界復元の識別子を維持', isolated.appId, 'kyokai-fukugen-map-v1');
await isolateCtx.close();

/* ---------- 25. スマホのタップ操作 ---------- */
const mobileCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3
});
const mobile = await mobileCtx.newPage();
await mobile.addInitScript(() => { self.__noTiles = true; });
await mobile.goto(BASE);
await mobile.waitForFunction(() => typeof draw === 'function' && typeof store === 'object');
await mobile.evaluate(() => document.getElementById('settingsPanel').classList.add('show'));
const touchUi = await mobile.evaluate(() => {
  const rect = sel => {
    const r=document.querySelector(sel).getBoundingClientRect();
    return {w:r.width,h:r.height};
  };
  return {
    hitRadius: TOUCH_HIT_RADIUS,
    follow: rect('#followBtn'),
    zoom: [...document.querySelectorAll('#zoomBox button')].map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})),
    tabs: [...document.querySelectorAll('#ribbonTabs button')].map(b=>b.getBoundingClientRect().height),
    close: rect('#settingsPanel .close'),
    field: rect('#setWorker'),
    save: rect('#settingsPanel .saveBtn'),
    labelWidth: getComputedStyle(document.querySelector('#settingsPanel .formRow label')).width
  };
});
eq('タッチ端末の選点半径は44px', touchUi.hitRadius, 44);
ok('現在地ボタンは52px以上', touchUi.follow.w >= 52 && touchUi.follow.h >= 52, touchUi.follow);
ok('拡大縮小は48px以上', touchUi.zoom.every(r => r.w >= 48 && r.h >= 48), touchUi.zoom);
ok('下部タブは48px以上', touchUi.tabs.every(h => h >= 48), touchUi.tabs);
ok('閉じるボタンは48px以上', touchUi.close.w >= 48 && touchUi.close.h >= 48, touchUi.close);
ok('入力欄は48px以上', touchUi.field.h >= 48, touchUi.field);
ok('保存ボタンは52px以上', touchUi.save.h >= 52, touchUi.save);
ok('狭い画面では項目名が入力欄の上に回る', parseFloat(touchUi.labelWidth) > 300, touchUi.labelWidth);
ok('タッチ時の指ぶれを14pxまで許容', readFileSync(APP, 'utf8').includes("e.pointerType==='touch'?14:8"));
await mobileCtx.close();

/* ---------- 24. v0.6までのデータが「現場１」へ移ること ----------
   いちばん怖いのは移行の失敗なので、専用のページで作り直して確かめる。 */
const page3 = await ctx.newPage();
const errors3 = [];
page3.on('pageerror', e => errors3.push(String(e)));
await page3.addInitScript(() => { self.__noTiles = true; });
await page3.goto(BASE);
await page3.waitForFunction(() => typeof store === 'object' && typeof siteList === 'function');
await page3.waitForTimeout(200);

/* v0.6の姿（'store' キーに1現場ぶん）を作り、現場の仕組みを消す */
const seeded = await page3.evaluate(async bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  store.points = []; store.refPoints = []; store.lines = [];
  store.routes = []; store.strokes = []; store.imports = [];
  invalidatePtMap(); invalidatePlotMap();
  pendingImport = { file: { name: '旧データ.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  document.getElementById('impName').value = '引き継ぎ確認';
  commitImport();
  store.settings.worker = '旧作業者';
  store.settings.zone = 12;
  setRec(store.points[0].id, 'da', '金属標');
  setRec(store.points[1].id, 'ki', '木杭');
  setDisp('lineColor', '#0088aa');
  /* v0.6の flushSave は store 全体を 'store' キーへ入れていた */
  const legacy = JSON.stringify(store);
  await idbReq(DB_STORE, 'readwrite', st => st.clear());
  await idbPut(DB_STORE, legacy, DB_KEY);
  await idbReq('snapshots', 'readwrite', st => st.clear());
  /* 現場が付いていない古い控えも1件置く */
  await idbPut('snapshots', { id: new Date().toISOString(), date: realTodayStr(),
                              json: legacy, pt: store.points.length, rt: 0, st: 0 });
  return { pts: store.points.length, lines: store.lines.length,
           done: progCounts().done, bytes: legacy.length };
}, simBytes);
eq('移行のもとになるデータを用意した', seeded.pts, 2397);
eq('画地も4件', seeded.lines, 4);
eq('記録も2点', seeded.done, 2);

await page3.reload();
await page3.waitForFunction(() => typeof store === 'object' && siteList().length > 0);
await page3.waitForTimeout(400);
const mig = await page3.evaluate(async () => ({
  sites: siteList().length,
  name: activeSiteName(),
  pts: store.points.length,
  lines: store.lines.length,
  done: progCounts().done,
  imports: store.imports.map(i => i.name),
  worker: store.settings.worker,
  zone: store.settings.zone,
  lineColor: disp('lineColor'),
  chip: document.getElementById('siteChip').textContent,
  meta: siteList()[0],
  siteRec: !!(await idbGet(DB_STORE, siteKey(sites.active))),
  legacyKept: !!(await idbGet(DB_STORE, DB_KEY)),
  snapsAdopted: (await idbReq('snapshots', 'readonly', s => s.getAll())).every(r => !!r.siteId),
}));
ok('移行でエラーが出ない', errors3.length === 0, errors3.slice(0, 3));
eq('現場は1件になる', mig.sites, 1);
eq('その名前は現場１', mig.name, '現場１');
eq('境界点がそのまま入る', mig.pts, 2397);
eq('画地もそのまま入る', mig.lines, 4);
eq('記録もそのまま残る', mig.done, 2);
eq('取込ファイルも残る', mig.imports.join(','), '引き継ぎ確認');
eq('作業者名も引き継ぐ', mig.worker, '旧作業者');
eq('座標系も引き継ぐ', mig.zone, 12);
eq('表示設定も引き継ぐ', mig.lineColor, '#0088aa');
eq('ヘッダーに現場名が出る', mig.chip, '現場１');
eq('目録に点数が入る', mig.meta.pts, 2397);
eq('目録に記録数が入る', mig.meta.done, 2);
eq('現場ごとのキーへ書き直される', mig.siteRec, true);
eq('念のため旧キーは消さずに残す', mig.legacyKept, true);
eq('古い控えも現場に結び付ける', mig.snapsAdopted, true);

/* もう一度開いても二重に移行しない */
await page3.reload();
await page3.waitForFunction(() => typeof store === 'object' && siteList().length > 0);
await page3.waitForTimeout(300);
const mig2 = await page3.evaluate(() => ({ sites: siteList().length, pts: store.points.length,
                                           name: activeSiteName(), done: progCounts().done }));
eq('開き直しても現場は1件のまま', mig2.sites, 1);
eq('点も増えない', mig2.pts, 2397);
eq('記録も変わらない', mig2.done, 2);
eq('名前も変わらない', mig2.name, '現場１');

/* ---------- 25. 控えを「新しい現場として読む」 ---------- */
const asNew = await page3.evaluate(async () => {
  const orgP = window.prompt, orgA = window.alert;
  window.prompt = (m, d) => '控えから作った現場';
  window.alert = () => {};
  const out = {};
  const payload = JSON.parse(siteJson());
  payload.siteName = 'よその現場';
  payload.siteId = 'xxxxx';
  pendingMerge = { file: { name: 'よその現場_控え.json' }, data: payload };
  showMergeChoice();
  out.warned = document.getElementById('mergeInfo').textContent.includes('別の現場');
  await doMergeAsNew();
  out.sites = siteList().length;
  out.name = activeSiteName();
  out.pts = store.points.length;
  out.done = progCounts().done;
  /* 合流のほうも試す（いまの現場へ足しても二重にならない） */
  pendingMerge = { file: { name: 'same.json' }, data: JSON.parse(siteJson()) };
  await doMergeHere();
  out.afterMerge = store.points.length;
  window.prompt = orgP; window.alert = orgA;
  return out;
});
ok('別の現場の控えだと警告する', asNew.warned, asNew.warned);
eq('新しい現場として読める', asNew.sites, 2);
eq('入れた名前になる', asNew.name, '控えから作った現場');
eq('中身が入る', asNew.pts, 2397);
eq('記録も入る', asNew.done, 2);
eq('同じ控えを合流しても増えない', asNew.afterMerge, 2397);

await browser.close();
srv.close();

console.log(`\n${pass + fail} 項目 / 合格 ${pass} / 不合格 ${fail}`);
if (fails.length) { console.log('\n--- 不合格 ---'); fails.forEach(f => console.log('  ✗ ' + f)); }
process.exit(fail ? 1 : 0);
