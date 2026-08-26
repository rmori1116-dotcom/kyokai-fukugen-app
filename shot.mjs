/* 画面の見た目を確かめる（shots/ にPNGを出す） */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'shots');
mkdirSync(OUT, { recursive: true });
const simBytes = Array.from(readFileSync(join(here, 'sample', '画地サンプル.sim')));

const srv = createServer((req, res) => {
  const n = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'fukugen-map.html';
  const f = join(here, 'dist', n);
  if (!existsSync(f)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': n.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}/fukugen-map.html`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 412, height: 850 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('ERR', e.message));
await page.addInitScript(() => { self.__noTiles = true; });
await page.goto(BASE);
await page.waitForFunction(() => typeof draw === 'function');
await page.waitForTimeout(300);

const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); console.log('  ' + name); };

await shot('1_起動');

await page.evaluate(bytes => {
  const txt = decodeText(new Uint8Array(bytes).buffer);
  pendingImport = { file: { name: '令和8年度調査図一覧図.sim' }, parsed: parseSimaFull(txt), src: 'sima' };
  importKind = 'bp';
  renderImportKind();
  showImportPreview();
}, simBytes);
await page.waitForTimeout(150);
await shot('2_取込の確認');

await page.evaluate(() => { document.getElementById('impName').value = '野田地区'; commitImport(); });
await page.waitForTimeout(200);
await page.evaluate(() => { setTab('rec'); });
await page.waitForTimeout(150);
await shot('3_全体_線と粒');

// 記録を入れてから全体を見る（進み具合が色で見えるか）
const perf = await page.evaluate(() => {
  store.settings.worker = '森';
  const step = 7;
  for (let i = 0; i < store.points.length; i += step) {
    store.points[i].rec = { k: i % 3 === 0 ? 'da' : 'ki', d: todayStr(), w: '森',
                            s: 'コンクリート杭', t: Date.now() };
  }
  updateProg();
  fitToBox(store.points.map(p => p.x), store.points.map(p => p.y));
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) draw();
  const wide = (performance.now() - t0) / 20;
  fitToLine(store.lines[2].id);
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) draw();
  const near = (performance.now() - t1) / 20;
  return { wide, near, counts: progCounts() };
});
console.log(`  描画1回: 全体 ${perf.wide.toFixed(1)}ms / 寄り ${perf.near.toFixed(1)}ms`, perf.counts);
await page.evaluate(() => { fitToBox(store.points.map(p => p.x), store.points.map(p => p.y)); });
await page.waitForTimeout(120);
await shot('4_全体_進み具合');

await page.evaluate(() => { fitToLine(store.lines[2].id); });
await page.waitForTimeout(120);
await shot('5_画地に寄る');

await page.evaluate(() => { state.view.scale *= 6; draw(); });
await page.waitForTimeout(120);
await shot('6_拡大_点名と距離');

await page.evaluate(() => { openRec(store.points[3].id); });
await page.waitForTimeout(150);
await shot('7_記録画面');
await page.evaluate(() => closePanel('recPanel'));

await page.evaluate(() => { setTab('meas'); const a=store.points[0], b=store.points[1], c=store.points[2];
  state.currentRoute=[a.id,b.id,c.id]; fitToBox([a.x,b.x,c.x],[a.y,b.y,c.y]); updateActionbar(); draw(); });
await page.waitForTimeout(150);
await shot('8_計測中');

await page.evaluate(() => { commitRoute(); openList('pt'); setPtGroup('st'); ptOpenAll(); });
await page.waitForTimeout(200);
await shot('9_一覧');
await page.evaluate(() => closePanel('listPanel'));

await page.evaluate(() => { openLayers(); });
await page.waitForTimeout(150);
await shot('10_レイヤ');
await page.evaluate(() => closePanel('layerPanel'));

await page.evaluate(() => { setTab('prep'); });
await page.waitForTimeout(150);
await shot('11_準備タブ');

await browser.close();
srv.close();
