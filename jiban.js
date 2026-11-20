/* ================= 地番図（法務省 登記所備付地図・地図XML） =================
   法務省がG空間情報センターで無償公開している「地図XML」（市区町村ごとのzip、または個別のXML）を
   端末に取り込んで、地番と筆界を重ねて表示する。通信は要らない。取り込んだデータは端末内（IndexedDB）に残るので、圏外でも使える。

   ・座標系が「公共座標n系」のもの（地籍調査済みなどの地図）… そのまま地図に重ねる。
   ・座標系が「任意座標系」のもの（地籍調査が済んでいない地区の公図）… 実際の位置を持たないので、
     いったん画面の中央へ仮置きし、［位置合わせ］で2点を合わせて位置・向き・縮尺を決める。
     公図は精度が低いので、合わせたあとも参考表示。境界の確定や登記の用には使えない。

   取り込みは app.js 本体に触れず、この塊だけで完結する（app.js には呼び出し口が数行あるだけ）。 */
const JIBAN_KEY = 'jiban:index';
const JIBAN_DATA = 'jiban:d:';
const JIBAN_MAX_VERTS = 2500000;     // 1回の取り込みで受け入れる頂点数の上限（端末の保存容量を守る）
const JIBAN_DRAW_MAX  = 6000;        // 画面内の筆がこれを超えたら線は描かない（拡大を促す）
const JIBAN_LABEL_MAX = 400;         // 地番を出す筆数の上限
const JIBAN_LABEL_MIN_W = 30;        // 筆が画面でこれより狭ければ地番を出さない（px）
const JIBAN_FREE_COLOR = '#e8590c';  // 任意座標系（公図）の色
const JIBAN_CREDIT = '地番図：法務省 登記所備付地図データ（G空間情報センター）　参考表示';
const J = { loaded:false, items:[], data:{}, alpha:0.85, color:'#c2255c', labels:true,
            sel:null, place:null, area:null, busy:false, dense:false };

/* ---------- 座標のやりとり ---------- */
function jibanToPlane(x,y){      // 地図の座標 → 平面直角（東,北）
  if(state.geographic){ try{ return currentProj().forward([x,y]); }catch(e){} }
  return [x,y];
}
function jibanFromPlane(E,N){    // 平面直角（東,北）→ 地図の座標
  if(state.geographic){ try{ return currentProj().inverse([E,N]); }catch(e){} }
  return [E,N];
}

/* ---------- 地図XMLの読み取り ---------- */
function jibanKid(el,name){
  for(let c=el.firstElementChild;c;c=c.nextElementSibling) if(c.localName===name) return c;
  return null;
}
function jibanText(el,name){ const k=el&&jibanKid(el,name); return k?k.textContent.trim():''; }
function jibanDP(dp){            // DirectPosition → [東(Y),北(X)]。XMLは X=北, Y=東
  const X=parseFloat(jibanText(dp,'X')), Y=parseFloat(jibanText(dp,'Y'));
  return (isFinite(X)&&isFinite(Y)) ? [Y,X] : null;
}
function jibanDist2(a,b){ const dx=a[0]-b[0], dy=a[1]-b[1]; return dx*dx+dy*dy; }
function jibanChain(ids, curveOf){
  const cs=[];
  for(const id of ids){ const c=curveOf(id); if(c&&c.length) cs.push(c); }
  if(!cs.length) return [];
  /* 先頭の線が逆向きなら直す（次の線とつながる端を探す） */
  if(cs.length>1){
    const a=cs[0], b=cs[1];
    const e=a[a.length-1], s=a[0];
    const dEnd=Math.min(jibanDist2(e,b[0]), jibanDist2(e,b[b.length-1]));
    const dStart=Math.min(jibanDist2(s,b[0]), jibanDist2(s,b[b.length-1]));
    if(dStart<dEnd) cs[0]=a.slice().reverse();
  }
  const out=[];
  for(let k=0;k<cs.length;k++){
    let c=cs[k];
    if(out.length){
      const last=out[out.length-1];
      if(jibanDist2(last,c[c.length-1]) < jibanDist2(last,c[0])) c=c.slice().reverse();
      for(let i=(jibanDist2(last,c[0])<1e-6?1:0); i<c.length; i++) out.push(c[i]);
    }else{
      for(let i=0;i<c.length;i++) out.push(c[i]);
    }
  }
  return out;
}
/* 1つの地図XML（文字列）を読む。返り値 { head, parcels, verts }
   parcels の各要素: { t:地番, o:大字, a:丁目, k:小字, y:予備, q:精度区分, s:座標値種別, r:[フラット座標の配列…（先頭が外周）] }
   座標は x=東, y=北（XMLのY, X）。 */
function jibanParseXml(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.getElementsByTagName('parsererror').length) throw new Error('XMLとして読めません');
  const root=doc.documentElement;
  if(!root || root.localName!=='地図') throw new Error('地図XMLではありません');
  const head={ name:jibanText(root,'地図名'), cityCode:jibanText(root,'市区町村コード'),
               city:jibanText(root,'市区町村名'), crs:jibanText(root,'座標系'), datum:jibanText(root,'測地系判別') };
  const NS='*';
  const pts=new Map();
  for(const p of doc.getElementsByTagNameNS(NS,'GM_Point')){
    const dp=p.getElementsByTagNameNS(NS,'DirectPosition')[0];
    const xy=dp&&jibanDP(dp); if(xy&&p.getAttribute('id')) pts.set(p.getAttribute('id'),xy);
  }
  const curves=new Map(), orient=new Map();
  for(const c of doc.getElementsByTagNameNS(NS,'GM_Curve')){
    const id=c.getAttribute('id'); if(!id) continue;
    const seq=[];
    for(const col of c.getElementsByTagNameNS(NS,'GM_PointArray.column')){
      const ref=col.getElementsByTagNameNS(NS,'GM_PointRef.point')[0];
      if(ref){ const q=pts.get(ref.getAttribute('idref')); if(q) seq.push(q); continue; }
      const dp=col.getElementsByTagNameNS(NS,'DirectPosition')[0];
      const q=dp&&jibanDP(dp); if(q) seq.push(q);
    }
    curves.set(id,seq);
  }
  for(const o of doc.getElementsByTagNameNS(NS,'GM_OrientableCurve')){
    const id=o.getAttribute('id'); if(!id) continue;
    const prim=jibanKid(o,'GM_OrientablePrimitive.primitive');
    const ori=jibanText(o,'GM_OrientablePrimitive.orientation');
    orient.set(id,{ prim:prim?prim.getAttribute('idref'):'', neg:ori==='-' });
  }
  const curveOf=id=>{
    const o=orient.get(id);
    if(o){ const base=curves.get(o.prim); return base&&o.neg ? base.slice().reverse() : base; }
    return curves.get(id);
  };
  const round3=v=>Math.round(v*1000)/1000;
  const flat=ring=>{ const f=[]; for(const q of ring){ f.push(round3(q[0]),round3(q[1])); } return f; };
  const ringsOf=wrap=>{
    const ids=[]; for(const g of wrap.getElementsByTagNameNS(NS,'GM_CompositeCurve.generator')) ids.push(g.getAttribute('idref'));
    return flat(jibanChain(ids,curveOf));
  };
  const surfaces=new Map();
  for(const s of doc.getElementsByTagNameNS(NS,'GM_Surface')){
    const id=s.getAttribute('id'); if(!id) continue;
    const rings=[];
    const ex=s.getElementsByTagNameNS(NS,'GM_SurfaceBoundary.exterior')[0];
    if(ex){ const r=ringsOf(ex); if(r.length>=6) rings.push(r); }
    if(!rings.length) continue;
    for(const inn of s.getElementsByTagNameNS(NS,'GM_SurfaceBoundary.interior')){
      const r=ringsOf(inn); if(r.length>=6) rings.push(r);
    }
    surfaces.set(id,rings);
  }
  const parcels=[]; let verts=0;
  for(const f of doc.getElementsByTagNameNS(NS,'筆')){
    const sh=jibanKid(f,'形状'); if(!sh) continue;
    const rings=surfaces.get(sh.getAttribute('idref')); if(!rings) continue;
    for(const r of rings) verts+=r.length/2;
    parcels.push({ t:jibanText(f,'地番'), o:jibanText(f,'大字名'), a:jibanText(f,'丁目名'),
                   k:jibanText(f,'小字名'), y:jibanText(f,'予備名'),
                   q:jibanText(f,'精度区分'), s:jibanText(f,'座標値種別'), r:rings });
  }
  return { head, parcels, verts };
}

/* ---------- zipの展開（外部ライブラリなし。ブラウザ標準の展開機能を使う） ---------- */
async function jibanInflate(data){
  if(typeof DecompressionStream==='undefined')
    throw new Error('このブラウザはzipの展開に未対応です。zipを展開してXMLを選んでください');
  const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function jibanUnzip(buf){        // → [{ name, get() }]
  const u8=new Uint8Array(buf), dv=new DataView(buf);
  let e=-1;
  for(let i=u8.length-22;i>=Math.max(0,u8.length-70000);i--){ if(dv.getUint32(i,true)===0x06054b50){ e=i; break; } }
  if(e<0) throw new Error('zipとして読めません');
  const n=dv.getUint16(e+10,true); let p=dv.getUint32(e+16,true);
  const out=[];
  for(let k=0;k<n;k++){
    if(p+46>u8.length || dv.getUint32(p,true)!==0x02014b50) break;
    const flag=dv.getUint16(p+8,true), method=dv.getUint16(p+10,true);
    const csize=dv.getUint32(p+20,true), usize=dv.getUint32(p+24,true);
    const nl=dv.getUint16(p+28,true), xl=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true);
    const lho=dv.getUint32(p+42,true);
    const nb=u8.subarray(p+46,p+46+nl);
    let name; try{ name=new TextDecoder((flag&0x800)?'utf-8':'shift_jis').decode(nb); }catch(_){ name=String.fromCharCode(...nb); }
    p+=46+nl+xl+cl;
    if(name.endsWith('/')) continue;
    if(csize===0xFFFFFFFF||usize===0xFFFFFFFF||lho===0xFFFFFFFF) throw new Error('4GBを超えるzipには未対応です');
    out.push({ name, get:async()=>{
      const nl2=dv.getUint16(lho+26,true), xl2=dv.getUint16(lho+28,true);
      const st=lho+30+nl2+xl2, data=u8.subarray(st,st+csize);
      if(method===0) return data;
      if(method===8) return jibanInflate(data);
      throw new Error('未対応の圧縮方式です');
    }});
  }
  return out;
}
async function jibanCollect(files){
  const items=[];
  const addZip=async(buf,label)=>{
    for(const en of jibanUnzip(buf)){
      const low=en.name.toLowerCase();
      if(low.endsWith('.xml')) items.push({ name:en.name, get:en.get });
      else if(low.endsWith('.zip')){ const inner=await en.get(); await addZip(inner.buffer.slice(inner.byteOffset,inner.byteOffset+inner.byteLength),en.name); }
    }
  };
  for(const f of files){
    const low=f.name.toLowerCase();
    if(low.endsWith('.xml')) items.push({ name:f.name, get:async()=>new Uint8Array(await f.arrayBuffer()) });
    else if(low.endsWith('.zip')) await addZip(await f.arrayBuffer(), f.name);
  }
  return items;
}

/* ---------- 取り込み ---------- */
function jibanId(){ return 'j'+newId(); }
async function jibanSaveIndex(){
  const meta=J.items.map(d=>({ id:d.id, name:d.name, city:d.city, kind:d.kind, zone:d.zone, n:d.n, verts:d.verts,
                               tf:d.tf, placed:d.placed, hidden:d.hidden, ts:d.ts, crs:d.crs }));
  await idbPut(DB_STORE, JSON.stringify({ v:1, items:meta, alpha:J.alpha, color:J.color, labels:J.labels }), JIBAN_KEY);
}
function jibanBBox(parcels){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const p of parcels){ const r=p.r[0]; for(let i=0;i<r.length;i+=2){
    if(r[i]<x0)x0=r[i]; if(r[i]>x1)x1=r[i]; if(r[i+1]<y0)y0=r[i+1]; if(r[i+1]>y1)y1=r[i+1]; } }
  return [x0,y0,x1,y1];
}

/* ---------- 地籍調査未終了地区（任意座標系）を小字別に見る ---------- */
function jibanAreaParts(ds,p){
  return [ds.city||'',p.o||'',p.a||'',p.k||'',p.y||''].map(v=>String(v).trim());
}
function jibanAreaKey(ds,p){ return JSON.stringify(jibanAreaParts(ds,p)); }
function jibanAreaLabel(parts){
  const area=parts.slice(1).filter(Boolean).join(' ');
  return area||'（小字名なし）';
}
function jibanAreaGroups(){
  if(J._areas) return J._areas;
  const map=new Map();
  for(const ds of J.items){
    if(ds.kind!=='free' || !J.data[ds.id]) continue;
    for(const p of J.data[ds.id]){
      const parts=jibanAreaParts(ds,p), key=JSON.stringify(parts);
      let g=map.get(key);
      if(!g){ g={ key, parts, city:parts[0], label:jibanAreaLabel(parts), n:0, sets:new Map() }; map.set(key,g); }
      g.n++;
      g.sets.set(ds.id,(g.sets.get(ds.id)||0)+1);
    }
  }
  return (J._areas=Array.from(map.values()));
}
function jibanAreaMatch(ds,i){
  if(!J.area) return true;
  if(ds.kind!=='free' || (J.area.dsId && J.area.dsId!==ds.id)) return false;
  if(J.area.indexSet && J.area.dsId===ds.id) return J.area.indexSet.has(i);
  const p=J.data[ds.id]&&J.data[ds.id][i];
  return !!p && jibanAreaKey(ds,p)===J.area.key;
}
function jibanAreaIndices(ds){
  const p=J.data[ds.id]||[], out=[];
  for(let i=0;i<p.length;i++) if(jibanAreaMatch(ds,i)) out.push(i);
  return out;
}
function jibanAreaEnc(v){ return encodeURIComponent(v).replace(/'/g,'%27'); }
function openJibanAreas(){
  closePanel('layerPanel');
  const q=document.getElementById('jibanAreaSearch'); if(q) q.value='';
  jibanRenderAreas('');
  openPanel('jibanAreaPanel');
}
function jibanRenderAreas(query){
  const box=document.getElementById('jibanAreaRows'); if(!box) return;
  const q=String(query||'').trim().toLocaleLowerCase('ja');
  const all=jibanAreaGroups();
  const groups=q ? all.filter(g=>(g.city+' '+g.label).toLocaleLowerCase('ja').includes(q)) : all;
  document.getElementById('jibanAreaCount').textContent=`${groups.length}小字（任意座標XML ${new Set(groups.flatMap(g=>Array.from(g.sets.keys()))).size}図面）`;
  if(!all.length){
    box.innerHTML='<div class="noteBox">地籍調査未終了地区のXMLがまだありません。レイヤ画面の［地図XMLを取り込む］から、市区町村ZIPまたはXMLを選んでください。</div>';
    return;
  }
  if(!groups.length){ box.innerHTML='<p style="color:#888;font-size:14px;">一致する小字がありません。</p>'; return; }
  const shown=groups.slice(0,300);
  box.innerHTML=shown.map(g=>{
    const files=Array.from(g.sets.entries()).map(([id,n])=>{
      const ds=J.items.find(d=>d.id===id); if(!ds) return '';
      return `<button type="button" class="saveBtn" style="margin:7px 0 0;background:#fff1e6;color:#9a3412;box-shadow:none;border:1px solid #fdba74;text-align:left;"
        onclick="jibanViewerOpen('${jibanAreaEnc(g.key)}','${id}')"><b>公図ビューアで見る</b><br><span style="font-size:12px;font-weight:normal;">${esc(ds.name)}　${n}筆</span></button>`;
    }).join('');
    return `<section style="padding:12px 0;border-bottom:1px solid #e2e8ee;">
      <div style="display:flex;gap:8px;align-items:flex-start;"><div style="flex:1;"><b style="font-size:16px;color:#1e3a5f;">${esc(g.label)}</b>
      <div style="font-size:12.5px;color:#667085;margin-top:3px;">${esc(g.city||'市区町村名なし')}</div></div>
      <span class="coords">${g.n}筆／${g.sets.size}図面</span></div>${files}</section>`;
  }).join('')+(groups.length>shown.length?`<p class="noteBox">先頭の${shown.length}小字を表示しています。上の検索欄で絞り込んでください。</p>`:'');
}
function jibanAreaOpen(encodedKey,dsId){
  const key=decodeURIComponent(encodedKey), g=jibanAreaGroups().find(x=>x.key===key);
  const ds=J.items.find(d=>d.id===dsId && d.kind==='free');
  if(!g||!ds){ toast('選んだ小字のXMLが見つかりません'); return; }
  const indices=[];
  for(let i=0;i<J.data[ds.id].length;i++) if(jibanAreaKey(ds,J.data[ds.id][i])===key) indices.push(i);
  J.area={ key, dsId, label:g.label, city:g.city, indices, indexSet:new Set(indices) };
  store.layers.jiban=true; ds.hidden=false; J.sel=null; save();
  closePanel('jibanAreaPanel');
  jibanFit(dsId,true);
  toast(`${g.label}の公図を表示しました`);
}
function jibanAreaClear(showLayers){
  J.area=null; J.sel=null; draw();
  if(showLayers) openLayers();
  else if(panelOpen('jibanAreaPanel')) jibanRenderAreas(document.getElementById('jibanAreaSearch').value);
}

/* ---------- 任意座標の公図専用ビューア（背景地図を使わない） ---------- */
const JV={ ds:null, key:'', indices:[], cx:0, cy:0, scale:1, ptr:new Map(), moved:false, ready:false };
function jibanViewerOpen(encodedKey,dsId){
  const key=decodeURIComponent(encodedKey), ds=J.items.find(d=>d.id===dsId&&d.kind==='free');
  if(!ds){ toast('公図XMLが見つかりません'); return; }
  const indices=[];
  for(let i=0;i<J.data[ds.id].length;i++) if(jibanAreaKey(ds,J.data[ds.id][i])===key) indices.push(i);
  if(!indices.length){ toast('選んだ小字の筆がありません'); return; }
  const parts=JSON.parse(key), label=jibanAreaLabel(parts);
  JV.ds=ds; JV.key=key; JV.indices=indices; JV.ptr.clear(); JV.moved=false;
  document.getElementById('jibanViewerTitle').textContent=`${label} 公図ビューア`;
  document.getElementById('jibanViewerCount').textContent=`${indices.length}筆`;
  document.getElementById('jibanViewerInfo').innerHTML='<b>'+esc(ds.name)+'</b><br>筆をタップすると地番と属性を表示します。';
  closePanel('jibanAreaPanel'); openPanel('jibanViewerPanel');
  jibanViewerInit();
  requestAnimationFrame(()=>{ jibanViewerResize(); jibanViewerFit(); });
}
function jibanViewerClose(){ JV.ptr.clear(); closePanel('jibanViewerPanel'); openJibanAreas(); }
function jibanViewerCanvas(){ return document.getElementById('jibanViewerCanvas'); }
function jibanViewerResize(){
  const c=jibanViewerCanvas(); if(!c||!JV.ds) return;
  const r=c.getBoundingClientRect(), d=Math.min(2,devicePixelRatio||1);
  const w=Math.max(1,Math.round(r.width*d)), h=Math.max(1,Math.round(r.height*d));
  if(c.width!==w||c.height!==h){ c.width=w; c.height=h; }
  jibanViewerDraw();
}
function jibanViewerFit(){
  if(!JV.ds) return;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  const ps=J.data[JV.ds.id];
  for(const i of JV.indices) for(const r of ps[i].r) for(let k=0;k<r.length;k+=2){
    if(r[k]<x0)x0=r[k]; if(r[k]>x1)x1=r[k]; if(r[k+1]<y0)y0=r[k+1]; if(r[k+1]>y1)y1=r[k+1];
  }
  const c=jibanViewerCanvas(), rc=c.getBoundingClientRect(); if(!isFinite(x0)||!rc.width) return;
  JV.cx=(x0+x1)/2; JV.cy=(y0+y1)/2;
  JV.scale=Math.max(0.0001,Math.min(rc.width/Math.max(1,x1-x0),rc.height/Math.max(1,y1-y0))*0.88);
  jibanViewerDraw();
}
function jibanViewerZoom(f){
  JV.scale=Math.max(0.000001,Math.min(1e6,JV.scale*f)); jibanViewerDraw();
}
function jibanViewerPoint(sx,sy){
  const c=jibanViewerCanvas(), r=c.getBoundingClientRect();
  return [JV.cx+(sx-r.left-r.width/2)/JV.scale,JV.cy-(sy-r.top-r.height/2)/JV.scale];
}
function jibanViewerDraw(){
  const c=jibanViewerCanvas(); if(!c||!JV.ds) return;
  const g=c.getContext('2d'), rc=c.getBoundingClientRect(), d=c.width/Math.max(1,rc.width);
  g.setTransform(d,0,0,d,0,0); g.clearRect(0,0,rc.width,rc.height);
  const ps=J.data[JV.ds.id], sx=x=>(x-JV.cx)*JV.scale+rc.width/2, sy=y=>(JV.cy-y)*JV.scale+rc.height/2;
  g.lineJoin='round'; g.lineCap='round'; g.strokeStyle=JIBAN_FREE_COLOR; g.fillStyle='rgba(232,89,12,.08)'; g.lineWidth=1.4;
  for(const i of JV.indices){
    g.beginPath();
    for(const r of ps[i].r){ for(let k=0;k<r.length;k+=2) k?g.lineTo(sx(r[k]),sy(r[k+1])):g.moveTo(sx(r[k]),sy(r[k+1])); g.closePath(); }
    g.fill('evenodd'); g.stroke();
  }
  if(JV.indices.length<=1200){
    g.font='bold 12px system-ui,sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    for(const i of JV.indices){
      const r=ps[i].r[0]; let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for(let k=0;k<r.length;k+=2){ x0=Math.min(x0,r[k]);x1=Math.max(x1,r[k]);y0=Math.min(y0,r[k+1]);y1=Math.max(y1,r[k+1]); }
      const x=sx((x0+x1)/2), y=sy((y0+y1)/2), t=ps[i].t||'';
      if(!t||(x1-x0)*JV.scale<22||(y1-y0)*JV.scale<13) continue;
      g.lineWidth=3;g.strokeStyle='rgba(255,255,255,.92)';g.strokeText(t,x,y);g.fillStyle='#9a3412';g.fillText(t,x,y);
    }
  }
}
function jibanViewerHit(clientX,clientY){
  if(!JV.ds) return null;
  const [x,y]=jibanViewerPoint(clientX,clientY), ps=J.data[JV.ds.id];
  for(let n=JV.indices.length-1;n>=0;n--){ const i=JV.indices[n]; if(jibanInside(ps[i].r,x,y)) return ps[i]; }
  return null;
}
function jibanViewerInit(){
  if(JV.ready) return; JV.ready=true;
  const c=jibanViewerCanvas();
  const snap=()=>{ const a=Array.from(JV.ptr.values()); return a.length===2?{d:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y),x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2}:null; };
  c.addEventListener('pointerdown',e=>{ c.setPointerCapture(e.pointerId); JV.ptr.set(e.pointerId,{x:e.clientX,y:e.clientY}); JV.pinch=snap(); JV.moved=false; });
  c.addEventListener('pointermove',e=>{
    const old=JV.ptr.get(e.pointerId); if(!old) return;
    if(JV.ptr.size===1){ JV.cx-=(e.clientX-old.x)/JV.scale; JV.cy+=(e.clientY-old.y)/JV.scale; if(Math.hypot(e.clientX-old.x,e.clientY-old.y)>2)JV.moved=true; JV.ptr.set(e.pointerId,{x:e.clientX,y:e.clientY}); }
    else{ const before=JV.pinch; JV.ptr.set(e.pointerId,{x:e.clientX,y:e.clientY}); const after=snap(); if(before&&after&&before.d>0){ const anchor=jibanViewerPoint(before.x,before.y); JV.scale=Math.max(.000001,Math.min(1e6,JV.scale*after.d/before.d)); const now=jibanViewerPoint(after.x,after.y); JV.cx+=anchor[0]-now[0]; JV.cy+=anchor[1]-now[1]; JV.moved=true; } JV.pinch=after; }
    jibanViewerDraw();
  });
  const up=e=>{ const was=JV.ptr.get(e.pointerId); JV.ptr.delete(e.pointerId); JV.pinch=snap(); if(was&&!JV.moved&&!JV.ptr.size){ const p=jibanViewerHit(e.clientX,e.clientY), info=document.getElementById('jibanViewerInfo'); if(p){ const a=[p.o,p.a,p.k,p.y].filter(Boolean).join(' '); info.innerHTML=`<b>地番 ${esc(p.t||'（なし）')}</b>　${esc(a)}<br>精度区分 ${esc(p.q||'—')}　座標値種別 ${esc(p.s||'—')}`; } } };
  c.addEventListener('pointerup',up); c.addEventListener('pointercancel',up);
  c.addEventListener('wheel',e=>{ e.preventDefault(); const a=jibanViewerPoint(e.clientX,e.clientY), f=e.deltaY<0?1.18:0.85; JV.scale=Math.max(.000001,Math.min(1e6,JV.scale*f)); const b=jibanViewerPoint(e.clientX,e.clientY); JV.cx+=a[0]-b[0];JV.cy+=a[1]-b[1];jibanViewerDraw(); },{passive:false});
  window.addEventListener('resize',()=>{ if(panelOpen('jibanViewerPanel')) jibanViewerResize(); });
}

/* ---------- G空間情報センターからウェブ取得 ---------- */
const JIBAN_CKAN='https://www.geospatial.jp/ckan/api/3/action/';
const JW={ results:[] };
function openJibanWeb(){
  closePanel('jibanAreaPanel');
  document.getElementById('jibanWebStatus').textContent='市区町村名を入力して検索してください。';
  document.getElementById('jibanWebRows').innerHTML='';
  openPanel('jibanWebPanel');
}
function jibanWebOpenAccount(){ window.open('https://front.geospatial.jp/how_to_use/manual8/','_blank','noopener'); }
function jibanWebToken(){ return String(document.getElementById('jibanWebToken').value||'').trim(); }
async function jibanWebJson(action,params){
  const u=new URL(JIBAN_CKAN+action); Object.entries(params||{}).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetch(u,{headers:{Accept:'application/json'}}); if(!r.ok) throw new Error(`公式APIが応答しません（${r.status}）`);
  const x=await r.json(); if(!x.success) throw new Error('公式APIから検索結果を取得できません'); return x.result;
}
function jibanWebZipResources(pkg){
  return (pkg.resources||[]).filter(r=>/\.zip$/i.test(r.name||r.url||'')).sort((a,b)=>{
    const ya=+(String(a.name).match(/(20\d{2})\.zip$/i)||[0,0])[1], yb=+(String(b.name).match(/(20\d{2})\.zip$/i)||[0,0])[1]; return yb-ya;
  });
}
function jibanWebSize(n){ if(!+n)return ''; return +n>1048576?(+n/1048576).toFixed(0)+'MB':Math.ceil(+n/1024)+'KB'; }
async function jibanWebSearch(){
  const city=String(document.getElementById('jibanWebCity').value||'').trim();
  if(!city){ toast('市区町村名を入力してください'); return; }
  const st=document.getElementById('jibanWebStatus'), box=document.getElementById('jibanWebRows');
  st.textContent='G空間情報センターを検索しています…'; box.innerHTML='';
  try{
    const r=await jibanWebJson('package_search',{q:`${city} 登記所備付地図データ`,rows:'50'});
    JW.results=(r.results||[]).filter(p=>String(p.owner_org||'').startsWith('moj-')&&jibanWebZipResources(p).length);
    st.textContent=`${JW.results.length}件見つかりました。最新版を取得します。`;
    box.innerHTML=JW.results.length?JW.results.map((p,i)=>{ const z=jibanWebZipResources(p)[0]; return `<div class="listRow"><span style="flex:1"><b>${esc(p.title||p.name)}</b><br><span style="font-size:12px;color:#667085;">${esc(z.name||'XML ZIP')} ${jibanWebSize(z.size)}</span></span><button type="button" class="saveBtn" style="margin:0;width:auto;background:#e8590c;" onclick="jibanWebDownload(${i})">取得して見る</button></div>`; }).join(''):'<div class="noteBox">該当する公式XMLが見つかりません。市区町村名を「長崎市」のように入力してください。</div>';
  }catch(e){
    st.textContent=e.message||e; box.innerHTML='<div class="noteBox">公式サイトが混雑中、またはブラウザからの通信が制限されています。時間をおいて再検索するか、公式配布ページを開いてください。</div><button type="button" class="saveBtn" onclick="window.open(\'https://front.geospatial.jp/moj-chizu-xml-readme/moj-chizu-xml-download/\',\'_blank\',\'noopener\')">公式配布ページを開く</button>';
  }
}
async function jibanWebDownload(i){
  const p=JW.results[i], z=p&&jibanWebZipResources(p)[0]; if(!p||!z) return;
  if(!document.getElementById('jibanWebAgree').checked){ toast('利用規約を確認し、同意欄にチェックしてください'); return; }
  const token=jibanWebToken(); if(!token){ toast('G空間情報センターのAPIトークンを入力してください'); return; }
  showProgress(`${z.name}を公式サイトから取得しています…`);
  try{
    const r=await fetch(z.url,{headers:{Authorization:token,Accept:'application/zip'}});
    if(!r.ok) throw new Error(`取得できません（${r.status}）`);
    const b=await r.arrayBuffer(), u=new Uint8Array(b,0,Math.min(4,b.byteLength));
    if(b.byteLength<4||u[0]!==0x50||u[1]!==0x4b) throw new Error('ZIPではなくログイン画面が返されました');
    hideProgress(); closePanel('jibanWebPanel');
    await jibanImportFiles([new File([b],z.name||'houmukyoku.zip',{type:'application/zip'})]);
    openJibanAreas();
  }catch(e){
    hideProgress();
    const page=`https://www.geospatial.jp/ckan/dataset/${encodeURIComponent(p.name||p.id)}`;
    showAlert('公式サイトから直接取得できませんでした：'+esc(e.message||e)+'<br>ログインや利用規約への同意が必要な場合は、公式ページで手続きをしてください。',[{label:'公式ページを開く',fn:`window.open('${page}','_blank','noopener');hideAlert()`},{label:'閉じる',fn:'hideAlert()'}]);
  }
}
async function jibanImportFiles(fileList){
  if(J.busy){ toast('取り込み中です'); return; }
  const files=Array.from(fileList||[]); if(!files.length) return;
  J.busy=true;
  let job=null;
  try{
    showProgress('地図XMLを確認しています…');
    const items=await jibanCollect(files);
    if(!items.length){ hideProgress(); toast('地図XML（.xml / .zip）が見つかりません'); return; }
    job=startJob('地図XMLを読み込み中…', items.length);
    const pub=new Map(), free=[]; const errs=[]; let verts=0, over=false, nOk=0;
    for(let i=0;i<items.length;i++){
      if(job.cancel) break;
      updateJob(i, `地図XMLを読み込み中（${i+1}/${items.length}）${items[i].name.split('/').pop()}`);
      await new Promise(r=>setTimeout(r,0));
      let r;
      try{
        const bytes=await items[i].get();
        r=jibanParseXml(new TextDecoder('utf-8').decode(bytes));
      }catch(e){ errs.push(items[i].name.split('/').pop()+'：'+(e.message||e)); continue; }
      if(!r.parcels.length) continue;
      const m=/^公共座標(\d{1,2})系$/.exec(r.head.crs);
      if(m && +m[1]>=1 && +m[1]<=19){
        const z=+m[1];
        let g=pub.get(z); if(!g){ g={ zone:z, city:r.head.city, parcels:[], verts:0 }; pub.set(z,g); }
        for(const p of r.parcels) g.parcels.push(p);
        g.verts+=r.verts;
      }else if(r.head.crs==='任意座標系'){
        free.push({ city:r.head.city, name:r.head.name, parcels:r.parcels, verts:r.verts });
      }else{ errs.push(items[i].name.split('/').pop()+'：座標系「'+r.head.crs+'」は未対応です'); continue; }
      nOk++; verts+=r.verts;
      if(verts>JIBAN_MAX_VERTS){ over=true; break; }
    }
    const made=[];
    const put=async(meta,parcels)=>{
      const old=J.items.findIndex(d=>d.name===meta.name && d.kind===meta.kind);
      if(old>=0){ const o=J.items[old]; if(meta.kind==='free'&&o.placed){ meta.tf=o.tf; meta.placed=true; } await jibanDrop(o.id,true); }
      meta.id=jibanId(); meta.ts=Date.now(); meta.hidden=false;
      await idbPut(DB_STORE, JSON.stringify(parcels), JIBAN_DATA+meta.id);
      J.data[meta.id]=parcels; J.items.push(meta); made.push(meta); J._areas=null;
    };
    for(const g of pub.values())
      await put({ name:`${g.city||'地図'}（公共座標${g.zone}系）`, city:g.city, kind:'pub', zone:g.zone, n:g.parcels.length,
                  verts:g.verts, tf:null, placed:true, crs:`公共座標${g.zone}系` }, g.parcels);
    const ctr=jibanToPlane(state.view.cx,state.view.cy);
    for(const f of free){
      const bb=jibanBBox(f.parcels);
      await put({ name:`${f.city||''} ${f.name||'公図'}`.trim(), city:f.city, kind:'free', zone:0, n:f.parcels.length,
                  verts:f.verts, tf:{ a:1, b:0, tx:ctr[0]-(bb[0]+bb[2])/2, ty:ctr[1]-(bb[1]+bb[3])/2 },
                  placed:false, crs:'任意座標系' }, f.parcels);
    }
    await jibanSaveIndex();
    store.layers.jiban=true; save();
    const cancelled=job.cancel;
    endJob(); job=null; hideProgress();
    const nPub=made.filter(d=>d.kind==='pub').length, nFree=made.filter(d=>d.kind==='free').length;
    if(made.length){
      const first=made.find(d=>d.kind==='pub')||made[0];
      jibanFit(first.id);
    }
    const msg=`${nOk}ファイルを取り込みました（公共座標 ${nPub}件／任意座標 ${nFree}件）`
      +(nFree?'。任意座標系は仮置きです。［位置合わせ］で2点を合わせてください':'');
    const warn=[]; if(over) warn.push('上限（頂点250万）に達したため、残りは取り込んでいません。範囲を分けて取り込んでください');
    if(cancelled) warn.push('中止しました');
    if(errs.length) warn.push(`読めなかったファイル ${errs.length}件：${errs.slice(0,2).join(' / ')}`);
    if(warn.length) { showAlert(esc(msg)+'<br>'+warn.map(esc).join('<br>'),[{label:'閉じる',fn:'hideAlert()'}]); document.getElementById('alertBar').style.background='#c9741a'; }
    else toast(msg);
    if(panelOpen('layerPanel')) openLayers();
  }catch(e){
    if(job) endJob();
    hideProgress();
    showAlert('地図XMLを取り込めませんでした：'+esc(e.message||e),[{label:'閉じる',fn:'hideAlert()'}]);
  }finally{ J.busy=false; }
}
function jibanPick(){
  const inp=document.createElement('input');
  inp.type='file'; inp.multiple=true;
  inp.accept='.xml,.zip,application/xml,text/xml,application/zip';
  inp.style.display='none';
  inp.onchange=()=>{ const fs=Array.from(inp.files||[]); inp.remove(); jibanImportFiles(fs); };
  document.body.appendChild(inp);
  inp.click();
}
async function jibanDrop(id, keepIndex){
  const i=J.items.findIndex(d=>d.id===id); if(i<0) return;
  J.items.splice(i,1); delete J.data[id];
  J._areas=null;
  if(J.sel && J.sel.id===id) J.sel=null;
  if(J.area && J.area.dsId===id) J.area=null;
  try{ await idbReq(DB_STORE,'readwrite',s=>s.delete(JIBAN_DATA+id)); }catch(e){}
  if(!keepIndex) await jibanSaveIndex();
}
async function jibanDel(id){
  const d=J.items.find(x=>x.id===id); if(!d) return;
  if(!confirm(`「${d.name}」を削除します。取り込み直せば元に戻せます。`)) return;
  await jibanDrop(id); draw();
  if(panelOpen('layerPanel')) openLayers();
}
async function jibanInit(){
  try{
    const raw=await idbGet(DB_STORE, JIBAN_KEY);
    if(raw){
      const ix=JSON.parse(raw);
      J.alpha=+ix.alpha>0?+ix.alpha:J.alpha; if(isColorHex(ix.color)) J.color=ix.color;
      J.labels=ix.labels!==false;
      for(const m of ix.items||[]){
        const s=await idbGet(DB_STORE, JIBAN_DATA+m.id);
        if(!s) continue;
        J.data[m.id]=JSON.parse(s); J.items.push(m);
      }
    }
  }catch(e){}
  J.loaded=true; draw();
}

/* ---------- 画面用の座標（現在の座標系・位置合わせに合わせて作り直す） ---------- */
function jibanCache(ds){
  const parcels=J.data[ds.id]; if(!parcels) return null;
  const cz=currentZone();
  const key=`${cz}|${state.geographic?1:0}|${ds.kind==='free'?JSON.stringify(ds.tf):ds.zone}`;
  if(ds._c && ds._c.key===key) return ds._c;
  let pa=null, pb=null;
  if(ds.kind==='pub' && ds.zone!==cz){ pa=proj4(zoneProj(ds.zone)); pb=proj4(zoneProj(cz)); }
  const geo=state.geographic ? currentProj() : null;
  const tf=ds.kind==='free'?ds.tf:null;
  const conv=(e,n)=>{
    if(tf){ const E=tf.a*e-tf.b*n+tf.tx, N=tf.b*e+tf.a*n+tf.ty; e=E; n=N; }
    else if(pa){ try{ const ll=pa.inverse([e,n]); const q=pb.forward(ll); e=q[0]; n=q[1]; }catch(_){} }
    if(geo){ try{ const ll=geo.inverse([e,n]); return ll; }catch(_){} }
    return [e,n];
  };
  const bb=new Float64Array(parcels.length*4), rs=new Array(parcels.length);
  for(let i=0;i<parcels.length;i++){
    const rings=parcels[i].r, out=new Array(rings.length);
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(let k=0;k<rings.length;k++){
      const r=rings[k], f=new Float64Array(r.length);
      for(let j=0;j<r.length;j+=2){
        const q=conv(r[j],r[j+1]); f[j]=q[0]; f[j+1]=q[1];
        if(k===0){ if(q[0]<x0)x0=q[0]; if(q[0]>x1)x1=q[0]; if(q[1]<y0)y0=q[1]; if(q[1]>y1)y1=q[1]; }
      }
      out[k]=f;
    }
    rs[i]=out; bb[4*i]=x0; bb[4*i+1]=y0; bb[4*i+2]=x1; bb[4*i+3]=y1;
  }
  ds._c={ key, bb, rs, lp:new Array(parcels.length) };
  return ds._c;
}
function jibanPip(r,x,y){        // 点が輪の中か（偶奇）
  let ins=false;
  for(let i=0,j=r.length-2;i<r.length;j=i,i+=2){
    const xi=r[i], yi=r[i+1], xj=r[j], yj=r[j+1];
    if((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) ins=!ins;
  }
  return ins;
}
function jibanInside(rings,x,y){
  if(!jibanPip(rings[0],x,y)) return false;
  for(let k=1;k<rings.length;k++) if(jibanPip(rings[k],x,y)) return false;
  return true;
}
function jibanLabelPoint(c,i){   // 地番を置く場所（筆の内側）
  if(c.lp[i]!==undefined) return c.lp[i];
  const rings=c.rs[i], r=rings[0], n=r.length/2;
  const ox=r[0], oy=r[1];
  let a=0,cx=0,cy=0;
  for(let p=0,q=n-1;p<n;q=p++){
    const xi=r[2*p]-ox, yi=r[2*p+1]-oy, xj=r[2*q]-ox, yj=r[2*q+1]-oy;
    const f=xj*yi-xi*yj; a+=f; cx+=(xj+xi)*f; cy+=(yj+yi)*f;
  }
  let pt=null;
  if(a!==0){ const X=cx/(3*a)+ox, Y=cy/(3*a)+oy; if(jibanInside(rings,X,Y)) pt=[X,Y]; }
  if(!pt){   // 重心が外のとき：中ほどの高さで、内側がいちばん長いところの真ん中
    const y0=c.bb[4*i+1], y1=c.bb[4*i+3];
    let best=null, bl=-1;
    for(const t of [0.5,0.35,0.65,0.2,0.8]){
      const Y=y0+(y1-y0)*t, xs=[];
      for(let p=0,q=r.length-2;p<r.length;q=p,p+=2){
        const yi=r[p+1], yj=r[q+1];
        if((yi>Y)!==(yj>Y)) xs.push(r[p]+(Y-yi)*(r[q]-r[p])/(yj-yi));
      }
      xs.sort((u,v)=>u-v);
      for(let k=0;k+1<xs.length;k+=2){ const len=xs[k+1]-xs[k]; if(len>bl){ bl=len; best=[(xs[k]+xs[k+1])/2,Y]; } }
    }
    pt=best;
  }
  return (c.lp[i]=pt);
}

/* ---------- 描画 ---------- */
function jibanSets(){
  if(store.layers.jiban===false) return [];
  return J.items.filter(d=>!d.hidden && J.data[d.id] && (!J.area ||
    (d.kind==='free' && (!J.area.dsId || J.area.dsId===d.id) && J.data[d.id].some((_,i)=>jibanAreaMatch(d,i)))));
}
function jibanView(){
  const a=toMap(0,0), b=toMap(W,H);
  return [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.max(a[0],b[0]), Math.max(a[1],b[1])];
}
function jibanVisible(c,v,ds){
  const out=[]; const bb=c.bb;
  const only=J.area && ds && J.area.dsId===ds.id ? J.area.indices : null;
  const check=pi=>{ const i=pi*4;
    if(bb[i+2]<v[0]||bb[i]>v[2]||bb[i+3]<v[1]||bb[i+1]>v[3]) return;
    out.push(pi);
  };
  if(only){ for(const pi of only) check(pi); }
  else for(let i=0;i<bb.length;i+=4){
    if(ds && !jibanAreaMatch(ds,i/4)) continue;
    check(i/4);
  }
  return out;
}
function jibanRgba(hex,a){
  const n=parseInt(hex.slice(1),16);
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`;
}
function drawJiban(){
  J.dense=false;
  const sets=jibanSets(); if(!sets.length) return;
  const v=jibanView(), jobs=[]; let total=0;
  for(const ds of sets){
    const c=jibanCache(ds); if(!c) continue;
    const vis=jibanVisible(c,v,ds); total+=vis.length; jobs.push([ds,c,vis]);
  }
  if(total>JIBAN_DRAW_MAX){ J.dense=true; return; }
  const s=state.view.scale, cx=state.view.cx, cy=state.view.cy;
  ctx.save();
  ctx.lineJoin='round'; ctx.lineCap='round';
  for(const [ds,c,vis] of jobs){
    if(!vis.length) continue;
    const col = ds.kind==='free' ? JIBAN_FREE_COLOR : J.color;
    ctx.beginPath();
    for(const i of vis) for(const r of c.rs[i]){
      for(let j=0;j<r.length;j+=2){
        const X=(r[j]-cx)*s+W/2, Y=(cy-r[j+1])*s+H/2;
        j?ctx.lineTo(X,Y):ctx.moveTo(X,Y);
      }
      ctx.closePath();
    }
    ctx.globalAlpha=J.alpha*0.10; ctx.fillStyle=col; ctx.fill('evenodd');
    ctx.globalAlpha=J.alpha; ctx.strokeStyle=col; ctx.lineWidth=1.3;
    ctx.setLineDash(ds.kind==='free'&&!ds.placed ? [6,4] : []);
    ctx.stroke();
  }
  ctx.restore();
}
function drawJibanLabels(){
  const sets=jibanSets();
  const v=jibanView(), s=state.view.scale, cx=state.view.cx, cy=state.view.cy;
  let drewAny=false;
  if(sets.length){
    const px=12;
    ctx.save();
    ctx.font='bold '+px+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineJoin='round';
    let nLab=0;
    for(const ds of sets){
      const c=jibanCache(ds); if(!c) continue;
      const vis=jibanVisible(c,v,ds);
      if(vis.length) drewAny=true;
      if(!J.labels || J.dense) continue;
      const parcels=J.data[ds.id];
      const col = ds.kind==='free' ? JIBAN_FREE_COLOR : J.color;
      for(const i of vis){
        if(nLab>=JIBAN_LABEL_MAX) break;
        const t=parcels[i].t; if(!t) continue;
        const wpx=(c.bb[4*i+2]-c.bb[4*i])*s, hpx=(c.bb[4*i+3]-c.bb[4*i+1])*s;
        const tw=ctx.measureText(t).width;
        if(wpx<Math.max(JIBAN_LABEL_MIN_W,tw*0.8) || hpx<px) continue;
        const lp=jibanLabelPoint(c,i); if(!lp) continue;
        const X=(lp[0]-cx)*s+W/2, Y=(cy-lp[1])*s+H/2;
        if(X<0||X>W||Y<0||Y>H) continue;
        if(!placeLabel(X,Y,tw+6,px+4)) continue;
        ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.strokeText(t,X,Y);
        ctx.fillStyle=col; ctx.fillText(t,X,Y);
        nLab++;
      }
    }
    ctx.restore();
    /* 選んだ筆を太く */
    if(J.sel){
      const ds=J.items.find(d=>d.id===J.sel.id), c=ds&&jibanCache(ds);
      if(c && c.rs[J.sel.i]){
        ctx.save(); ctx.strokeStyle='#1e73d2'; ctx.fillStyle='rgba(30,115,210,.18)'; ctx.lineWidth=3; ctx.lineJoin='round';
        ctx.beginPath();
        for(const r of c.rs[J.sel.i]){
          for(let j=0;j<r.length;j+=2){ const X=(r[j]-cx)*s+W/2, Y=(cy-r[j+1])*s+H/2; j?ctx.lineTo(X,Y):ctx.moveTo(X,Y); }
          ctx.closePath();
        }
        ctx.fill('evenodd'); ctx.stroke(); ctx.restore();
      }
    }
    if(J.dense){
      ctx.save(); ctx.font='bold 14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      const msg='地番図は拡大すると表示します', w=ctx.measureText(msg).width+16;
      ctx.fillStyle='rgba(30,58,95,.85)'; ctx.fillRect(W/2-w/2,H*0.12,w,26);
      ctx.fillStyle='#fff'; ctx.fillText(msg,W/2,H*0.12+13); ctx.restore();
    }
    if(drewAny||J.dense){
      const r=creditBox();
      ctx.save(); ctx.font='11px system-ui, sans-serif';
      const w=ctx.measureText(JIBAN_CREDIT).width+8;
      ctx.fillStyle='rgba(255,255,255,.82)'; ctx.fillRect(4,r.y-r.h-2,w,r.h);
      ctx.fillStyle='#333'; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.fillText(JIBAN_CREDIT,8,r.y-r.h/2-2); ctx.restore();
    }
  }
  /* 位置合わせ中の目印 */
  const pl=J.place;
  if(pl){
    ctx.save(); ctx.lineWidth=3;
    const mark=(mx,my,col,txt)=>{
      const [X,Y]=toScr(mx,my);
      ctx.strokeStyle=col; ctx.fillStyle=col;
      ctx.beginPath(); ctx.arc(X,Y,13,0,7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X-18,Y); ctx.lineTo(X+18,Y); ctx.moveTo(X,Y-18); ctx.lineTo(X,Y+18); ctx.stroke();
      ctx.font='bold 14px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='bottom';
      ctx.lineWidth=4; ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.strokeText(txt,X+16,Y-14); ctx.fillText(txt,X+16,Y-14);
      ctx.lineWidth=3;
    };
    pl.pairs.forEach((p,k)=>mark(p.dstMap[0],p.dstMap[1],'#1a8f3c',`合わせた点${k+1}`));
    if(pl.src) mark(pl.src.map[0],pl.src.map[1],JIBAN_FREE_COLOR,`図上の点${pl.pairs.length+1}`);
    ctx.restore();
  }
}

/* ---------- タップ（属性の表示／位置合わせ） ---------- */
function jibanHit(sx,sy){
  const [mx,my]=toMap(sx,sy);
  for(const ds of jibanSets()){
    const c=jibanCache(ds); if(!c) continue;
    for(const i of jibanVisible(c,[mx,my,mx,my],ds)){
      const o=4*i;
      if(mx<c.bb[o]||mx>c.bb[o+2]||my<c.bb[o+1]||my>c.bb[o+3]) continue;
      if(jibanInside(c.rs[i],mx,my)) return { ds, i };
    }
  }
  return null;
}
function jibanClearSel(){ J.sel=null; hideAlert(); draw(); }
function jibanTap(sx,sy){
  if(J.place) return jibanPlaceTap(sx,sy);
  if(state.mode!=='view') return false;
  if(!jibanSets().length) return false;
  const h=jibanHit(sx,sy);
  if(!h){ if(J.sel){ J.sel=null; hideAlert(); draw(); } return false; }
  const p=J.data[h.ds.id][h.i];
  J.sel={ id:h.ds.id, i:h.i }; draw();
  const area=[p.o,p.a,p.k,p.y].filter(Boolean).join(' ');
  const free=h.ds.kind==='free';
  showAlert(`<b>地番 ${esc(p.t||'（なし）')}</b>　${esc(area)}<br>`
    +`精度区分 ${esc(p.q||'—')}　座標値種別 ${esc(p.s||'—')}　${esc(h.ds.crs)}<br>`
    +(free?(h.ds.placed?'公図（任意座標系）を2点で位置合わせした表示です。位置は目安です。':'公図（任意座標系）です。位置は仮置きで、実際の位置ではありません。')
           :'法務省 登記所備付地図データ。参考表示で、境界の確定・登記の証明には使えません。'),
    [{label:'閉じる',fn:'jibanClearSel()'}]);
  document.getElementById('alertBar').style.background='#1e3a5f';
  return true;
}

/* ---------- 公図（任意座標系）の位置合わせ ---------- */
function jibanBar(){
  let el=document.getElementById('jibanBar');
  const pl=J.place;
  if(!pl){ if(el) el.remove(); return; }
  if(!el){
    el=document.createElement('div'); el.id='jibanBar';
    el.style.cssText='position:fixed;left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 56px);z-index:60;'
      +'background:#e8590c;color:#fff;border-radius:10px;padding:10px 12px;font-size:15px;line-height:1.4;'
      +'display:flex;gap:10px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    document.body.appendChild(el);
  }
  const n=pl.pairs.length+1;
  const msg = pl.src
    ? `位置合わせ ${n}/2：その点の<b>実際の位置</b>をタップ（境界点・基準点は近くなら吸着します）`
    : `位置合わせ ${n}/2：<b>公図上の点（筆の角）</b>をタップ`;
  el.innerHTML=`<span style="flex:1">${msg}</span>`
    +`<button type="button" onclick="jibanPlaceCancel()" style="min-width:64px;min-height:44px;border:none;border-radius:8px;background:#fff;color:#c2410c;font-size:15px;font-weight:bold;">取消</button>`;
}
function jibanPlaceStart(id){
  const ds=J.items.find(d=>d.id===id); if(!ds||ds.kind!=='free') return;
  closePanel('layerPanel'); hideAlert();
  ds.hidden=false; store.layers.jiban=true;
  J.sel=null;
  J.place={ id, pairs:[], src:null, backup:{ tf:Object.assign({},ds.tf), placed:ds.placed } };
  jibanFit(id); jibanBar();
  toast('公図の2点を、実際の位置に合わせます');
}
function jibanPlaceCancel(){
  const pl=J.place; if(!pl) return;
  const ds=J.items.find(d=>d.id===pl.id);
  if(ds){ ds.tf=pl.backup.tf; ds.placed=pl.backup.placed; }
  J.place=null; jibanBar(); draw(); toast('位置合わせを取り消しました');
}
function jibanNearestVertex(ds,sx,sy,thr){
  const c=jibanCache(ds); if(!c) return null;
  const v=jibanView(), parcels=J.data[ds.id], s=state.view.scale;
  let best=null, bd=thr;
  for(const i of jibanVisible(c,v,ds)){
    const rings=c.rs[i];
    for(let k=0;k<rings.length;k++){
      const r=rings[k];
      for(let j=0;j<r.length;j+=2){
        const X=(r[j]-state.view.cx)*s+W/2, Y=(state.view.cy-r[j+1])*s+H/2;
        const d=Math.hypot(X-sx,Y-sy);
        if(d<bd){ bd=d; best={ map:[r[j],r[j+1]], local:[parcels[i].r[k][j],parcels[i].r[k][j+1]] }; }
      }
    }
  }
  return best;
}
function jibanPlaceTap(sx,sy){
  const pl=J.place, ds=J.items.find(d=>d.id===pl.id);
  if(!ds){ J.place=null; jibanBar(); return false; }
  if(!pl.src){
    const v=jibanNearestVertex(ds,sx,sy,TOUCH_HIT_RADIUS);
    if(!v){ toast('公図の筆の角が近くにありません。角の近くをタップしてください'); return true; }
    pl.src=v; jibanBar(); draw(); return true;
  }
  let dst, snapped=false;
  const p=nearestPoint(sx,sy,TOUCH_HIT_RADIUS,true);
  if(p){ dst=[p.x,p.y]; snapped=true; } else dst=toMap(sx,sy);
  const E=jibanToPlane(dst[0],dst[1]);
  pl.pairs.push({ src:pl.src.local, dst:E, dstMap:dst });
  pl.src=null;
  const tf=ds.tf;
  if(pl.pairs.length===1){
    /* 1点目：まず平行移動だけで合わせて、2点目を取りやすくする */
    const q=pl.pairs[0];
    tf.tx=q.dst[0]-(tf.a*q.src[0]-tf.b*q.src[1]);
    tf.ty=q.dst[1]-(tf.b*q.src[0]+tf.a*q.src[1]);
    toast(snapped?'1点目を点に合わせました。次は2点目':'1点目を合わせました。次は2点目');
    jibanBar(); draw(); return true;
  }
  const [q1,q2]=pl.pairs;
  const sx_=q2.src[0]-q1.src[0], sy_=q2.src[1]-q1.src[1];
  const dx_=q2.dst[0]-q1.dst[0], dy_=q2.dst[1]-q1.dst[1];
  const sl=sx_*sx_+sy_*sy_, dl=dx_*dx_+dy_*dy_;
  if(sl<1e-6 || dl<1e-6){
    pl.pairs.pop(); jibanBar(); draw();
    toast('2点が近すぎます。離れた別の点を選んでください'); return true;
  }
  const a=(dx_*sx_+dy_*sy_)/sl, b=(dy_*sx_-dx_*sy_)/sl;
  tf.a=a; tf.b=b;
  tf.tx=q1.dst[0]-(a*q1.src[0]-b*q1.src[1]);
  tf.ty=q1.dst[1]-(b*q1.src[0]+a*q1.src[1]);
  ds.placed=true;
  const scale=Math.hypot(a,b), rot=Math.atan2(b,a)*180/Math.PI;
  J.place=null; jibanBar();
  jibanSaveIndex().catch(()=>{});
  draw();
  toast(`位置合わせをしました（縮尺 ×${scale.toFixed(3)}、回転 ${rot.toFixed(2)}°）。公図の精度のため位置は目安です`);
  if(panelOpen('layerPanel')) openLayers();
  return true;
}

/* ---------- レイヤ画面 ---------- */
function jibanFit(id, areaOnly){
  if(!areaOnly) J.area=null;
  const ds=J.items.find(d=>d.id===id), c=ds&&jibanCache(ds); if(!c||!c.rs.length) return;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const pi of jibanAreaIndices(ds)){ const i=pi*4;
    if(c.bb[i]<x0)x0=c.bb[i]; if(c.bb[i+2]>x1)x1=c.bb[i+2];
    if(c.bb[i+1]<y0)y0=c.bb[i+1]; if(c.bb[i+3]>y1)y1=c.bb[i+3];
  }
  if(!isFinite(x0)) return;
  closePanel('layerPanel');
  closePanel('jibanAreaPanel');
  fitToBox([x0,x1],[y0,y1]);
  /* 市区町村全体のように広い範囲だと筆が多すぎて描かれないので、画面に筆が収まる程度まで寄せる */
  let guard=0;
  while(guard++<8){
    const vis=jibanVisible(c,jibanView(),ds).length;
    if(vis<=JIBAN_DRAW_MAX*0.8) break;
    state.view.scale=clampScale(state.view.scale*1.6);
  }
  draw();
}
function jibanToggleDs(id){
  const d=J.items.find(x=>x.id===id); if(!d) return;
  d.hidden=!d.hidden; jibanSaveIndex().catch(()=>{}); draw(); openLayers();
}
function jibanSetAlpha(v){ J.alpha=Math.min(1,Math.max(0.1,+v/100)); jibanSaveIndex().catch(()=>{}); draw(); }
function jibanSetColor(v){ if(!isColorHex(v)) return; J.color=v; jibanSaveIndex().catch(()=>{}); draw(); }
function jibanToggleLabels(){ J.labels=!J.labels; jibanSaveIndex().catch(()=>{}); draw(); openLayers(); }
function jibanLayerHtml(){
  const on=store.layers.jiban!==false;
  const alpha=Math.round(J.alpha*100);
  const tog=(f,flag)=>`<button type="button" class="del" style="background:${flag?'#e7f0fb':'#f0f0f0'};color:${flag?'#1e73d2':'#999'};min-width:52px;" onclick="${f}">${flag?'表示':'非表示'}</button>`;
  let h=`<div class="listRow">${tog("toggleLayer('jiban')",on)}
    <input type="color" class="layerCol" value="${esc(J.color)}" title="地番図の色" aria-label="地番図の色" onchange="jibanSetColor(this.value)">
    <span style="flex:1">地番図（法務省 地図XML）</span><span class="coords">${J.items.length?J.items.length+'件':'未読込'}</span></div>
  <div class="listRow" style="padding-top:0;"><span style="min-width:52px;"></span>
    <span style="flex:1;font-size:13px;color:#666c74;">透過率 <span id="jibanAlphaVal" style="color:#1e3a5f;font-weight:bold;">${alpha}%</span></span>
    <input id="jibanAlpha" type="range" min="10" max="100" step="5" value="${alpha}" style="flex:1.6;"
      oninput="document.getElementById('jibanAlphaVal').textContent=this.value+'%'" onchange="jibanSetAlpha(this.value)"></div>
  <div class="listRow" style="padding-top:0;">
    <button type="button" class="del" style="background:${J.labels?'#e7f0fb':'#f0f0f0'};color:${J.labels?'#1e73d2':'#999'};min-width:52px;" onclick="jibanToggleLabels()">${J.labels?'地番あり':'地番なし'}</button>
    <button type="button" class="del" style="flex:1;background:#e7f0fb;color:#1e3a5f;" onclick="jibanPick()">地図XML（.xml／.zip）を取り込む</button></div>`;
  const nArea=jibanAreaGroups().length;
  h+=`<div class="listRow" style="padding-top:0;">
    <button type="button" class="saveBtn" style="margin:0;flex:1;background:#e8590c;" onclick="openJibanAreas()">${nArea?`小字別に公図を見る（${nArea}小字）`:'ウェブ取得・公図ビューア'}</button>
    ${J.area?`<button type="button" class="del" onclick="jibanAreaClear(true)">全XML表示</button>`:''}</div>`;
  if(J.area) h+=`<div class="noteBox" style="margin:0 0 8px;border-color:#fdba74;background:#fff7ed;"><b>表示中：${esc(J.area.label)}</b><br>${esc(J.area.city||'')}／選択したXMLだけを表示しています。</div>`;
  for(const d of J.items){
    const free=d.kind==='free';
    h+=`<div class="listRow">${tog(`jibanToggleDs('${d.id}')`,!d.hidden)}
      <span class="stChip ${free?'no':'da'}" style="${free?`background:${JIBAN_FREE_COLOR};`:`background:${J.color};`}">${free?(d.placed?'公図(合致)':'公図(仮置)'):'公共'}</span>
      <span style="flex:1">${esc(d.name)}</span><span class="coords">${d.n}筆</span>
      <button type="button" class="del" onclick="jibanFit('${d.id}')" title="表示範囲へ移動">⤢</button>
      ${free?`<button type="button" class="del" style="background:#fff1e6;color:#c2410c;" onclick="jibanPlaceStart('${d.id}')">位置合わせ</button>`:''}
      <button type="button" class="del" onclick="jibanDel('${d.id}')">削除</button></div>`;
  }
  if(!J.items.length) h+='<p style="color:#888;font-size:14px;">［ウェブ取得・公図ビューア］から市区町村を検索して公式XMLを取得できます。手元のXML／ZIPを選ぶ方法も使えます。</p>';
  return h;
}
jibanInit();
