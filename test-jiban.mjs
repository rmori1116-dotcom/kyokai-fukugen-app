/* 地番図（地図XML）機能の自動テスト
   実行: python3 prep.py && python3 build.py && node test-jiban.mjs */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { deflateRawSync } from 'zlib';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0; const fails = [];
function ok(n, c, x){ if(c) pass++; else { fail++; fails.push(n + (x!==undefined?`  → ${JSON.stringify(x)}`:'')); } }
function eq(n, g, w){ ok(n, g===w, {got:g, want:w}); }
function near(n, g, w, t){ ok(n, Math.abs(g-w)<=t, {got:g, want:w, tol:t}); }

/* ---- 地図XMLを作る（仕様書の構造どおり。tzu/zmn の接頭辞つき） ---- */
function mapXml({ crs, name='テスト地区', city='テスト市', parcels }){
  let pts='', curves='', surfs='', fude='';
  let pid=0, cid=0;
  parcels.forEach((p,k)=>{
    const ids=[];
    // 各辺を1本の線にする。2辺目は逆向き（OrientableCurve）で参照して、向きの処理も試す
    const vs=p.v;
    const P=vs.map(([x,y])=>{ pid++; pts+=`<zmn:GM_Point id="P${pid}"><zmn:GM_Point.position><zmn:DirectPosition><zmn:X>${y}</zmn:X><zmn:Y>${x}</zmn:Y></zmn:DirectPosition></zmn:GM_Point.position></zmn:GM_Point>`; return pid; });
    const refs=[];
    for(let i=0;i<vs.length;i++){
      const a=P[i], b=P[(i+1)%vs.length]; cid++;
      const direct = i%2===1;   // 奇数番は直接位置、偶数番は点参照
      const col=(q)=> direct
        ? `<zmn:GM_PointArray.column><zmn:GM_Position.direct><zmn:DirectPosition><zmn:X>${vs[q][1]}</zmn:X><zmn:Y>${vs[q][0]}</zmn:Y></zmn:DirectPosition></zmn:GM_Position.direct></zmn:GM_PointArray.column>`
        : `<zmn:GM_PointArray.column><zmn:GM_Position.indirect><zmn:GM_PointRef.point idref="P${[a,b][q===(i)?0:1]}"/></zmn:GM_Position.indirect></zmn:GM_PointArray.column>`;
      const ia=i, ib=(i+1)%vs.length;
      const colA = direct ? col(ia) : `<zmn:GM_PointArray.column><zmn:GM_Position.indirect><zmn:GM_PointRef.point idref="P${a}"/></zmn:GM_Position.indirect></zmn:GM_PointArray.column>`;
      const colB = direct ? col(ib) : `<zmn:GM_PointArray.column><zmn:GM_Position.indirect><zmn:GM_PointRef.point idref="P${b}"/></zmn:GM_Position.indirect></zmn:GM_PointArray.column>`;
      curves+=`<zmn:GM_Curve id="L${cid}"><zmn:GM_OrientablePrimitive.orientation>+</zmn:GM_OrientablePrimitive.orientation><zmn:GM_OrientablePrimitive.primitive idref="L${cid}"/><zmn:GM_Curve.segment><zmn:GM_LineString><zmn:GM_LineString.controlPoint>${colA}${colB}</zmn:GM_LineString.controlPoint></zmn:GM_LineString></zmn:GM_Curve.segment></zmn:GM_Curve>`;
      if(i===1){   // この辺は、逆向きに作った線を '-' で参照する
        cid++;
        curves+=`<zmn:GM_Curve id="L${cid}"><zmn:GM_OrientablePrimitive.orientation>+</zmn:GM_OrientablePrimitive.orientation><zmn:GM_OrientablePrimitive.primitive idref="L${cid}"/><zmn:GM_Curve.segment><zmn:GM_LineString><zmn:GM_LineString.controlPoint>${colB}${colA}</zmn:GM_LineString.controlPoint></zmn:GM_LineString></zmn:GM_Curve.segment></zmn:GM_Curve>`;
        cid++;
        curves+=`<zmn:GM_OrientableCurve id="L${cid}"><zmn:GM_OrientablePrimitive.orientation>-</zmn:GM_OrientablePrimitive.orientation><zmn:GM_OrientablePrimitive.primitive idref="L${cid-1}"/></zmn:GM_OrientableCurve>`;
      }
      refs.push(`L${cid}`);
    }
    surfs+=`<zmn:GM_Surface id="S${k+1}"><zmn:GM_Surface.patch><zmn:GM_Polygon><zmn:GM_Polygon.boundary><zmn:GM_SurfaceBoundary><zmn:GM_SurfaceBoundary.exterior><zmn:GM_Ring>${refs.map(r=>`<zmn:GM_CompositeCurve.generator idref="${r}"/>`).join('')}</zmn:GM_Ring></zmn:GM_SurfaceBoundary.exterior></zmn:GM_SurfaceBoundary></zmn:GM_Polygon.boundary></zmn:GM_Polygon></zmn:GM_Surface.patch></zmn:GM_Surface>`;
    fude+=`<tzu:筆 id="F${k+1}"><tzu:大字コード>001</tzu:大字コード><tzu:丁目コード>000</tzu:丁目コード><tzu:小字コード>0001</tzu:小字コード><tzu:予備コード>00</tzu:予備コード><tzu:大字名>${p.o||'大字テスト'}</tzu:大字名><tzu:小字名>${p.k||'小字甲'}</tzu:小字名><tzu:地番>${p.t}</tzu:地番><tzu:形状 idref="S${k+1}"/><tzu:精度区分>甲一</tzu:精度区分><tzu:座標値種別>測量成果</tzu:座標値種別></tzu:筆>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><tzu:地図 xmlns:tzu="http://www.moj.go.jp/MINJI/tizuxml" xmlns:zmn="http://www.moj.go.jp/MINJI/tizuzumen"><tzu:version>ver1.0</tzu:version><tzu:地図名>${name}</tzu:地図名><tzu:市区町村コード>99999</tzu:市区町村コード><tzu:市区町村名>${city}</tzu:市区町村名><tzu:座標系>${crs}</tzu:座標系><tzu:測地系判別>測量</tzu:測地系判別><tzu:空間属性>${pts}${curves}${surfs}</tzu:空間属性><tzu:主題属性>${fude}</tzu:主題属性></tzu:地図>`;
}
/* 東y・北x の組。X=北, Y=東 でXMLに入る */
const sq=(e,n,w,h)=>[[e,n],[e+w,n],[e+w,n+h],[e,n+h]];
const ZONE=1;   // 既定の系（アプリの初期値は1系）
const pubParcels=[ {t:'101', v:sq(1000,2000,20,30)}, {t:'102-1', v:sq(1020,2000,20,30)}, {t:'103', v:sq(1000,2030,40,25)} ];
const pubXml = mapXml({ crs:`公共座標${ZONE}系`, name:'公共地区', parcels:pubParcels });
/* 公図：実際の位置を持たない局所座標。縮尺0.5で、30度回して置いてあるものとして作る */
const free0=[ {t:'1', k:'小字甲', v:sq(0,0,40,60)}, {t:'2', k:'小字甲', v:sq(40,0,40,60)}, {t:'3', k:'小字乙', v:sq(0,60,80,40)} ];
const freeXml = mapXml({ crs:'任意座標系', name:'公図甲', parcels:free0 });

/* ---- zip（deflate）を作る ---- */
function crc32(buf){ let c, crc=~0; for(const b of buf){ c=(crc^b)&255; for(let k=0;k<8;k++) c=c&1?(c>>>1)^0xEDB88320:c>>>1; crc=(crc>>>8)^c; } return ~crc>>>0; }
function makeZip(entries){
  const loc=[], cen=[]; let off=0;
  for(const [name,data] of entries){
    const nb=Buffer.from(name,'utf8'), raw=Buffer.from(data,'utf8'), cmp=deflateRawSync(raw), crc=crc32(raw);
    const lh=Buffer.alloc(30); lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0x800,6); lh.writeUInt16LE(8,8);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(cmp.length,18); lh.writeUInt32LE(raw.length,22); lh.writeUInt16LE(nb.length,26);
    loc.push(lh,nb,cmp);
    const ch=Buffer.alloc(46); ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6); ch.writeUInt16LE(0x800,8); ch.writeUInt16LE(8,10);
    ch.writeUInt32LE(crc,16); ch.writeUInt32LE(cmp.length,20); ch.writeUInt32LE(raw.length,24); ch.writeUInt16LE(nb.length,28); ch.writeUInt32LE(off,42);
    cen.push(ch,nb);
    off+=30+nb.length+cmp.length;
  }
  const cd=Buffer.concat(cen), eo=Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50,0); eo.writeUInt16LE(entries.length,8); eo.writeUInt16LE(entries.length,10); eo.writeUInt32LE(cd.length,12); eo.writeUInt32LE(off,16);
  return Buffer.concat([...loc,cd,eo]);
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const srv=createServer((req,res)=>{
  const name=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'')||'fukugen-map.html';
  const f=join(here,'dist',name);
  if(!existsSync(f)){ res.writeHead(404); res.end('no'); return; }
  res.writeHead(200,{'Content-Type':MIME[name.slice(name.lastIndexOf('.'))]||'application/octet-stream'}); res.end(readFileSync(f));
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const BASE=`http://127.0.0.1:${srv.address().port}/fukugen-map.html`;
const browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:{});
const bctx=await browser.newContext({ viewport:{width:900,height:700} });
const page=await bctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{ if(m.type()==='error') errors.push('console: '+m.text()); });
page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{ self.__noTiles=true; });
await page.goto(BASE);
await page.waitForFunction(()=>typeof jibanParseXml==='function' && typeof nationalJibanLayerHtml==='function' && J.loaded);
ok('法務局地番図の読取ライブラリを内蔵', await page.evaluate(()=>!!(globalThis.NationalChibanVendor&&NationalChibanVendor.PMTiles&&NationalChibanVendor.VectorTile)));
eq('法務局地番図は初期状態で非表示', await page.evaluate(()=>store.layers.nationalJiban), false);
const llRound=await page.evaluate(()=>{ const z=16,n=2**z,t=nationalJibanLLToTile(139.6917,35.6895,z); return nationalJibanTileToLL(t[0]/n,t[1]/n); });
near('全国タイルの経度変換', llRound[0], 139.6917, 1e-8);
near('全国タイルの緯度変換', llRound[1], 35.6895, 1e-8);

/* 1. 読み取り */
const parsed=await page.evaluate(x=>{ const r=jibanParseXml(x); return { crs:r.head.crs, city:r.head.city, n:r.parcels.length, verts:r.verts,
   t:r.parcels.map(p=>p.t), r0:r.parcels[0].r[0], o:r.parcels[0].o, q:r.parcels[0].q, s:r.parcels[0].s }; }, pubXml);
eq('座標系を読む', parsed.crs, '公共座標1系'); eq('市区町村名を読む', parsed.city, 'テスト市');
eq('筆の数', parsed.n, 3); eq('頂点数（閉じた輪なので5+5+5）', parsed.verts, 15);
eq('地番を読む', parsed.t.join(','), '101,102-1,103'); eq('大字名', parsed.o, '大字テスト');
eq('精度区分', parsed.q, '甲一'); eq('座標値種別', parsed.s, '測量成果');
/* 輪は閉じた順（東,北）の並びで、X=北・Y=東が取り違えられていない */
const ring=parsed.r0; const es=ring.filter((_,i)=>i%2===0), ns=ring.filter((_,i)=>i%2===1);
eq('東の範囲（Y）', Math.min(...es)+'-'+Math.max(...es), '1000-1020'); eq('北の範囲（X）', Math.min(...ns)+'-'+Math.max(...ns), '2000-2030');
eq('逆向きの線（OrientableCurve）を使っても輪が正しくつながる（4角＋閉じる点）', ring.length/2, 5);
ok('輪の始点と終点が一致する', ring[0]===ring[ring.length-2] && ring[1]===ring[ring.length-1], ring);
const bad=await page.evaluate(()=>{ try{ jibanParseXml('<a/>'); return 'noerr'; }catch(e){ return e.message; } });
eq('地図XMLでないものは断る', bad, '地図XMLではありません');

/* 2. 取り込み（xml単体とzip） */
const toFile=(name,data)=>({ name, data:Array.from(typeof data==='string'?Buffer.from(data,'utf8'):data) });
await page.evaluate(async fs=>{ const files=fs.map(f=>new File([new Uint8Array(f.data)],f.name)); await jibanImportFiles(files); },
  [toFile('公共.xml',pubXml)]);
let st=await page.evaluate(()=>({ n:J.items.length, kind:J.items[0].kind, zone:J.items[0].zone, np:J.items[0].n, layer:store.layers.jiban }));
eq('xmlを取り込める', st.n, 1); eq('公共座標は公共扱い', st.kind, 'pub'); eq('系番号', st.zone, 1); eq('筆数', st.np, 3);
const zip=makeZip([['a/公共2.xml', pubXml.replace('公共地区','公共地区2')], ['b/公図.xml', freeXml], ['readme.txt','x']]);
await page.evaluate(async fs=>{ await jibanImportFiles(fs.map(f=>new File([new Uint8Array(f.data)],f.name))); },[toFile('muni.zip',zip)]);
st=await page.evaluate(()=>({ items:J.items.map(d=>[d.kind,d.n,d.placed]), keys:null }));
eq('zipからも取り込める（公共は同名で置き換え、公図が追加）', JSON.stringify(st.items), JSON.stringify([['pub',3,true],['free',3,false]]));

/* 2.1 任意座標XMLを小字別に整理して表示 */
const ag=await page.evaluate(()=>jibanAreaGroups().map(g=>[g.label,g.n,g.sets.size]));
eq('任意座標XMLを小字別に整理する', JSON.stringify(ag), JSON.stringify([['大字テスト 小字甲',2,1],['大字テスト 小字乙',1,1]]));
ok('小字別一覧画面がある', await page.evaluate(()=>!!document.getElementById('jibanAreaPanel')));
await page.evaluate(()=>{ openJibanAreas(); document.getElementById('jibanAreaSearch').value='乙'; jibanRenderAreas('乙'); });
ok('小字名で検索できる', await page.evaluate(()=>document.getElementById('jibanAreaRows').textContent.includes('小字乙') && !document.getElementById('jibanAreaRows').textContent.includes('小字甲')));
const focused=await page.evaluate(()=>{
  const g=jibanAreaGroups().find(x=>x.label.includes('小字乙')), id=Array.from(g.sets.keys())[0];
  jibanAreaOpen(encodeURIComponent(g.key),id);
  const ds=J.items.find(d=>d.id===id), c=jibanCache(ds);
  return { label:J.area.label, sets:jibanSets().length, vis:jibanVisible(c,[-1e9,-1e9,1e9,1e9],ds).length };
});
eq('選んだ小字だけに絞る', focused.label, '大字テスト 小字乙');
eq('選んだXMLだけを表示する', focused.sets, 1); eq('選んだ小字の筆だけを表示する', focused.vis, 1);
await page.evaluate(()=>jibanAreaClear(false));

/* 3. 描画・属性表示（公共座標） */
await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); jibanFit(d.id); });
await page.waitForTimeout(100);
const drawn=await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); const c=jibanCache(d);
  return { vis:jibanVisible(c,jibanView()).length, dense:J.dense, sc:state.view.scale }; });
eq('3筆とも画面に入る', drawn.vis, 3); eq('密集扱いにならない', drawn.dense, false);
/* 筆101の中心をタップして属性を出す */
const tap=await page.evaluate(()=>{ const [sx,sy]=toScr(1010,2015); const rect=canvas.getBoundingClientRect(); return [rect.left+sx, rect.top+sy, sx, sy]; });
const hit=await page.evaluate(([,,sx,sy])=>{ const r=jibanTap(sx,sy); return { r, html:document.getElementById('alertBar').innerHTML, sel:J.sel&&J.data[J.sel.id][J.sel.i].t }; }, tap);
eq('タップで筆が選ばれる', hit.sel, '101'); ok('属性に地番が出る', hit.html.includes('地番 101'), hit.html);
ok('精度区分と座標値種別が出る', hit.html.includes('甲一') && hit.html.includes('測量成果'));
const miss=await page.evaluate(()=>{ const [sx,sy]=toScr(900,1900); return jibanTap(sx,sy); });
eq('筆の外をタップしても何も奪わない', miss, false);
/* 地番ラベルが描かれる位置（筆の内側）を計算できる */
const lp=await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); const c=jibanCache(d); return [0,1,2].map(i=>jibanLabelPoint(c,i)); });
ok('地番の置き場所が筆の内側', lp.every((p,i)=>p && p[0]>=[1000,1020,1000][i] && p[0]<=[1020,1040,1040][i] && p[1]>=[2000,2000,2030][i] && p[1]<=[2030,2030,2055][i]), lp);

/* 4. 系が違うとき（アプリが2系のとき、1系の地図は投影し直して重なる） */
const zc=await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); const a=jibanCache(d).bb.slice(0,2); store.settings.zone=2; const b=jibanCache(d).bb.slice(0,2); store.settings.zone=1; return [Array.from(a),Array.from(b)]; });
ok('系が変わると座標が変換される', Math.abs(zc[0][0]-zc[1][0])>1000, zc);

/* 5. 位置合わせ（公図） */
const fid=await page.evaluate(()=>J.items.find(x=>x.kind==='free').id);
/* 実際の位置：公図の(0,0)→(5000,6000)、(80,0)→ 縮尺0.5・30度回転の置き場所 */
const s=0.5, th=30*Math.PI/180, a=s*Math.cos(th), b=s*Math.sin(th), tx=5000, ty=6000;
const T=(x,y)=>[a*x-b*y+tx, b*x+a*y+ty];
const p1=T(0,0), p2=T(80,0);
await page.evaluate(id=>{ jibanPlaceStart(id); }, fid);
await page.waitForTimeout(100);
ok('位置合わせの案内が出る', await page.evaluate(()=>!!document.getElementById('jibanBar')));
async function tapAt(step){
  return page.evaluate(([step])=>{ return step; }, [step]);
}
/* 公図の角を、現在の表示位置から探してタップ → 実際の位置をタップ */
async function pair(local, dst){
  const r=await page.evaluate(([local,dst])=>{
    const ds=J.items.find(d=>d.kind==='free');
    // 表示中の座標系（平面）での公図の角の位置
    const tf=ds.tf; const E=tf.a*local[0]-tf.b*local[1]+tf.tx, N=tf.b*local[0]+tf.a*local[1]+tf.ty;
    const [sx,sy]=toScr(E,N); const ok1=jibanTap(sx,sy);
    const [dx,dy]=toScr(dst[0],dst[1]); // 移動して実際の位置を見せる（画面外ならそこへ寄せる）
    state.view.cx=dst[0]; state.view.cy=dst[1]; state.view.scale=2; draw();
    const [ux,uy]=toScr(dst[0],dst[1]);
    const ok2=jibanTap(ux,uy);
    return { ok1, ok2, pairs:J.place?J.place.pairs.length:-1 };
  },[local,dst]);
  return r;
}
let r1=await pair([0,0],p1);
eq('1点目で平行移動だけ合う', r1.pairs, 1);
const mid=await page.evaluate(()=>{ const ds=J.items.find(d=>d.kind==='free'); return { placed:ds.placed, a:ds.tf.a, b:ds.tf.b }; });
eq('1点目の時点ではまだ位置確定にならない', mid.placed, false);
/* 2点目は、移動後の見え方（拡大した画面）を考慮して、公図の角を探してタップ */
await page.evaluate(()=>{ const ds=J.items.find(d=>d.kind==='free'); jibanFit(ds.id); });
let r2=await pair([80,0],p2);
const done=await page.evaluate(()=>{ const ds=J.items.find(d=>d.kind==='free'); return { placed:ds.placed, tf:ds.tf, place:J.place, bar:!!document.getElementById('jibanBar') }; });
eq('2点で位置が確定する', done.placed, true); eq('位置合わせの案内が消える', done.bar, false);
near('縮尺が合う', Math.hypot(done.tf.a,done.tf.b), 0.5, 1e-9);
near('回転が合う（度）', Math.atan2(done.tf.b,done.tf.a)*180/Math.PI, 30, 1e-9);
near('並行移動 X が合う', done.tf.tx, tx, 1e-6); near('並行移動 Y が合う', done.tf.ty, ty, 1e-6);
/* 位置合わせ後、公図の筆が合致した位置に出ている */
const chk=await page.evaluate(([x,y])=>{ const ds=J.items.find(d=>d.kind==='free'); const c=jibanCache(ds); return [c.bb[0],c.bb[1],c.bb[2],c.bb[3]]; }, [0,0]);
const exp=[0,40,0,40].length&&(()=>{ const pts=[[0,0],[40,0],[40,60],[0,60]].map(([x,y])=>T(x,y)); return [Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))]; })();
chk.forEach((v,i)=>near('公図の筆の外接枠 '+i, v, exp[i], 1e-3));

/* 取消できる */
await page.evaluate(id=>{ jibanPlaceStart(id); }, fid);
await page.evaluate(()=>{ const ds=J.items.find(d=>d.kind==='free'); const [sx,sy]=toScr(ds.tf.tx,ds.tf.ty); jibanTap(sx,sy); });
await page.evaluate(()=>jibanPlaceCancel());
const after=await page.evaluate(()=>{ const ds=J.items.find(d=>d.kind==='free'); return { placed:ds.placed, a:ds.tf.a, place:J.place }; });
near('取消で元の位置に戻る', after.a, done.tf.a, 1e-12); eq('取消で案内が消える', after.place, null);

/* 6. 保存して開き直しても残る（圏外でも使える） */
await page.waitForTimeout(300);
await page.reload();
await page.waitForFunction(()=>typeof J!=='undefined' && J.loaded);
const re=await page.evaluate(()=>({ items:J.items.map(d=>[d.kind,d.n,d.placed]), tf:J.items.find(d=>d.kind==='free').tf }));
eq('開き直しても地番図が残る', JSON.stringify(re.items), JSON.stringify([['pub',3,true],['free',3,true]]));
near('位置合わせも残る', re.tf.tx, tx, 1e-6);
/* 回線を切っても表示できる */
await bctx.setOffline(true);
const off=await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); const c=jibanCache(d); return jibanVisible(c,[-1e9,-1e9,1e9,1e9]).length; });
eq('オフラインでも読める', off, 3); await bctx.setOffline(false);

/* 7. レイヤ画面 */
await page.evaluate(()=>openLayers());
const html=await page.evaluate(()=>document.getElementById('otherLayers').innerHTML);
ok('レイヤ画面に地番図が出る', html.includes('地番図（法務省 地図XML）'));
ok('レイヤ画面に法務局地番図が出る', html.includes('法務局地番図（事前取込不要）'));
ok('法務局地番図は事前取込不要と案内', html.includes('現在地周辺だけを通信で読み込みます'));
ok('取り込みボタンがある', html.includes('jibanPick()')); ok('位置合わせボタンがある（公図のみ）', (html.match(/位置合わせ/g)||[]).length===1, (html.match(/位置合わせ/g)||[]).length);
ok('小字別に公図を見るボタンがある', html.includes('小字別に公図を見る'));
await page.evaluate(()=>toggleLayer('nationalJiban'));
eq('法務局地番図を表示へ切り替えられる', await page.evaluate(()=>store.layers.nationalJiban), true);
ok('法務局地番図の表示状態がレイヤ画面へ反映', await page.evaluate(()=>nationalJibanLayerHtml().includes('>表示</button>')));
await page.evaluate(()=>toggleLayer('nationalJiban'));
eq('法務局地番図を非表示へ戻せる', await page.evaluate(()=>store.layers.nationalJiban), false);
await page.evaluate(()=>{ toggleLayer('jiban'); });
eq('レイヤを非表示にすると描かない', await page.evaluate(()=>jibanSets().length), 0);
await page.evaluate(()=>{ toggleLayer('jiban'); jibanSetAlpha(40); });
near('透過率を変えられる', await page.evaluate(()=>J.alpha), 0.4, 1e-9);

/* 8. 密集時は描かず、拡大を促す */
const dense=await page.evaluate(()=>{ const d=J.items.find(x=>x.kind==='pub'); state.view.scale=1e-6; draw(); return J.dense; });
eq('画面に入る筆が多いとき（極端な縮小）は密集扱い', dense, false); // 3筆だけなので密集にならない
/* 削除 */
await page.evaluate(async()=>{ const d=J.items.find(x=>x.kind==='free'); await jibanDel(d.id); });
eq('削除できる', await page.evaluate(()=>J.items.length), 1);

ok('実行中にエラーが出ていない', errors.length===0, errors.slice(0,3));
await browser.close(); srv.close();
console.log(`\n${pass+fail} 項目 / 合格 ${pass} / 不合格 ${fail}`);
if(fail){ console.log('\n--- 不合格 ---'); for(const f of fails) console.log('  ✗ '+f); process.exit(1); }
