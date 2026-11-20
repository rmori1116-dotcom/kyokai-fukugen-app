/* ================= 法務局地番図（オンライン・公共座標） =================
   法務省の登記所備付地図データを AMX Project が PMTiles 化し、
   農研機構の HABS が公開しているミラーから、いま見ている範囲だけを読む。

   任意座標系の公図は実世界の位置を持たないため、この全国レイヤには含まれない。
   その地区は従来どおり地図XMLを取り込み、2点で位置合わせして表示する。 */
const NATIONAL_CHIBAN_URL = 'https://habs.rad.naro.go.jp/spatial_data/amx/a.pmtiles';
const NATIONAL_CHIBAN_MIN_VIEW_Z = 15;
const NATIONAL_CHIBAN_MAX_Z = 16;
const NATIONAL_CHIBAN_MAX_TILES = 64;
const NATIONAL_CHIBAN_CACHE_MAX = 72;
const NATIONAL_CHIBAN_LABEL_MAX = 300;
const NATIONAL_CHIBAN_COLOR = '#c2255c';
const NATIONAL_CHIBAN_CREDIT = '法務局地番図：法務省 地図XML／AMX Project（公共座標・参考表示）';

const NC = {
  archive:null, tiles:new Map(), redrawPending:false,
  last:null, labels:[], shown:false
};

function nationalJibanEnabled(){ return store.layers.nationalJiban===true; }

function nationalJibanMapToLL(x,y,pr){
  try{
    const ll=state.geographic ? [x,y] : pr.inverse([x,y]);
    return ll && isFinite(ll[0]) && isFinite(ll[1]) ? ll : null;
  }catch(e){ return null; }
}
function nationalJibanLLToScreen(lon,lat,pr){
  try{
    const m=state.geographic ? [lon,lat] : pr.forward([lon,lat]);
    return isFinite(m[0]) && isFinite(m[1]) ? toScr(m[0],m[1]) : null;
  }catch(e){ return null; }
}
function nationalJibanLLToTile(lon,lat,z){
  const n=Math.pow(2,z);
  const x=(lon+180)/360*n;
  const clamped=Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180;
  const y=(1-Math.asinh(Math.tan(clamped))/Math.PI)/2*n;
  return [x,y];
}
function nationalJibanTileToLL(x,y){
  return [x*360-180, Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];
}

/* 画面上の1pxが経度何度かから、Web地図のズーム段を求める。
   平面直角座標でも経緯度の図面でも同じ計算を使える。 */
function nationalJibanWantedZoom(pr){
  const a=toMap(W/2,H/2), b=toMap(W/2+1,H/2);
  const la=nationalJibanMapToLL(a[0],a[1],pr), lb=nationalJibanMapToLL(b[0],b[1],pr);
  if(!la||!lb) return null;
  let d=Math.abs(lb[0]-la[0]);
  if(d>180) d=360-d;
  if(!(d>0)) return null;
  return Math.round(Math.log2(360/(d*256)));
}

function nationalJibanPlan(){
  if(!W||!H) return null;
  let pr;
  try{ pr=currentProj(); }catch(e){ return null; }
  const ll=[[0,0],[W,0],[0,H],[W,H]].map(([sx,sy])=>{
    const m=toMap(sx,sy); return nationalJibanMapToLL(m[0],m[1],pr);
  });
  if(ll.some(v=>!v)) return null;
  const want=nationalJibanWantedZoom(pr);
  if(want===null) return null;
  if(want<NATIONAL_CHIBAN_MIN_VIEW_Z) return { pr, want, tooFar:true, tiles:[] };
  const z=Math.min(NATIONAL_CHIBAN_MAX_Z,want), n=Math.pow(2,z);
  const lons=ll.map(v=>v[0]), lats=ll.map(v=>v[1]);
  const nw=nationalJibanLLToTile(Math.min(...lons),Math.max(...lats),z);
  const se=nationalJibanLLToTile(Math.max(...lons),Math.min(...lats),z);
  const x0=Math.max(0,Math.floor(nw[0])), x1=Math.min(n-1,Math.floor(se[0]));
  const y0=Math.max(0,Math.floor(nw[1])), y1=Math.min(n-1,Math.floor(se[1]));
  const count=(x1-x0+1)*(y1-y0+1);
  if(count<=0 || count>NATIONAL_CHIBAN_MAX_TILES) return { pr, want, tooFar:true, tiles:[] };
  const tiles=[];
  for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) tiles.push({z,x,y,key:`${z}/${x}/${y}`});
  return { pr, want, z, n, tooFar:false, tiles };
}

function nationalJibanArchive(){
  if(NC.archive) return NC.archive;
  const v=globalThis.NationalChibanVendor;
  if(!v || !v.PMTiles) return null;
  NC.archive=new v.PMTiles(NATIONAL_CHIBAN_URL);
  return NC.archive;
}
function nationalJibanParseTile(bytes){
  const v=globalThis.NationalChibanVendor;
  const tile=new v.VectorTile(new v.PbfReader(bytes));
  const layer=tile.layers.fude;
  if(!layer) return [];
  const out=[];
  for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);
    if(f.type!==3) continue;
    const rings=f.loadGeometry();
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    const rr=[];
    for(const ring of rings){
      const a=[];
      for(const p of ring){
        a.push(p.x,p.y);
        if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x;
        if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y;
      }
      if(a.length>=6) rr.push(a);
    }
    if(!rr.length) continue;
    const p=f.properties||{};
    out.push({ r:rr, e:f.extent||layer.extent||4096,
      t:String(p['地番']||''), area:[p['大字名'],p['丁目名'],p['小字名']].filter(Boolean).join(' '),
      c:[(x0+x1)/2,(y0+y1)/2], wh:[x1-x0,y1-y0] });
  }
  return out;
}
function nationalJibanEvict(){
  if(NC.tiles.size<=NATIONAL_CHIBAN_CACHE_MAX) return;
  const old=[...NC.tiles.entries()].filter(([,r])=>r.state!=='loading').sort((a,b)=>a[1].used-b[1].used);
  while(NC.tiles.size>NATIONAL_CHIBAN_CACHE_MAX && old.length) NC.tiles.delete(old.shift()[0]);
}
function nationalJibanScheduleRedraw(){
  if(NC.redrawPending) return;
  NC.redrawPending=true;
  requestAnimationFrame(()=>{
    NC.redrawPending=false;
    if(nationalJibanEnabled()) draw();
    if(panelOpen('layerPanel')) openLayers();
  });
}
function nationalJibanGetTile(t){
  let r=NC.tiles.get(t.key);
  if(r){ r.used=Date.now(); return r; }
  r={ state:'loading', features:null, used:Date.now(), error:'' };
  NC.tiles.set(t.key,r);
  if(!navigator.onLine){ r.state='offline'; r.error='offline'; return r; }
  const a=nationalJibanArchive();
  if(!a){ r.state='error'; r.error='library'; return r; }
  a.getZxy(t.z,t.x,t.y).then(res=>{
    r.features=res ? nationalJibanParseTile(res.data) : [];
    r.state='ready'; r.error=''; r.used=Date.now();
    nationalJibanEvict(); nationalJibanScheduleRedraw();
  }).catch(e=>{
    r.state='error'; r.error=String(e&&e.message||e||'error'); r.used=Date.now();
    nationalJibanScheduleRedraw();
  });
  return r;
}
function nationalJibanFeaturePoint(t,f,px,py,pr){
  const n=Math.pow(2,t.z), ll=nationalJibanTileToLL((t.x+px/f.e)/n,(t.y+py/f.e)/n);
  return nationalJibanLLToScreen(ll[0],ll[1],pr);
}

function drawNationalJiban(){
  NC.labels=[]; NC.shown=false;
  if(!nationalJibanEnabled()) { NC.last=null; return; }
  if(globalThis.__noTiles){ NC.last={test:true,tooFar:false,loading:0,errors:0,features:0,requested:0}; return; }
  const plan=nationalJibanPlan();
  if(!plan){ NC.last={tooFar:false,loading:0,errors:1,features:0,requested:0}; return; }
  if(plan.tooFar){ NC.last={tooFar:true,loading:0,errors:0,features:0,requested:0,want:plan.want}; return; }
  let loading=0,errors=0,total=0,ready=0;
  const jobs=[];
  for(const t of plan.tiles){
    const r=nationalJibanGetTile(t);
    if(r.state==='loading') loading++;
    else if(r.state==='error'||r.state==='offline') errors++;
    else if(r.state==='ready'){ ready++; total+=r.features.length; if(r.features.length) jobs.push([t,r.features]); }
  }
  NC.last={tooFar:false,loading,errors,features:total,requested:plan.tiles.length,ready,want:plan.want,z:plan.z};
  if(!jobs.length) return;
  NC.shown=true;
  ctx.save();
  ctx.lineJoin='round'; ctx.lineCap='round'; ctx.strokeStyle=NATIONAL_CHIBAN_COLOR; ctx.lineWidth=1.2;
  ctx.fillStyle='rgba(194,37,92,.075)';
  ctx.beginPath();
  for(const [t,fs] of jobs) for(const f of fs){
    for(const ring of f.r){
      let started=false;
      for(let i=0;i<ring.length;i+=2){
        const p=nationalJibanFeaturePoint(t,f,ring[i],ring[i+1],plan.pr);
        if(!p) continue;
        started ? ctx.lineTo(p[0],p[1]) : (ctx.moveTo(p[0],p[1]),started=true);
      }
      if(started) ctx.closePath();
    }
    if(plan.want>=16 && f.t && NC.labels.length<NATIONAL_CHIBAN_LABEL_MAX){
      const c=nationalJibanFeaturePoint(t,f,f.c[0],f.c[1],plan.pr);
      const a=nationalJibanFeaturePoint(t,f,f.c[0]+f.wh[0]/2,f.c[1]+f.wh[1]/2,plan.pr);
      if(c&&a) NC.labels.push({x:c[0],y:c[1],t:f.t,w:Math.abs(a[0]-c[0])*2,h:Math.abs(a[1]-c[1])*2});
    }
  }
  ctx.fill('evenodd'); ctx.stroke(); ctx.restore();
}

function drawNationalJibanLabels(){
  if(!nationalJibanEnabled() || !NC.shown) return;
  ctx.save(); ctx.font='bold 11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.lineJoin='round';
  let n=0;
  for(const p of NC.labels){
    if(p.x<0||p.x>W||p.y<0||p.y>H) continue;
    const tw=ctx.measureText(p.t).width;
    if(p.w<Math.max(24,tw*.75)||p.h<10) continue;
    if(!placeLabel(p.x,p.y,tw+5,14)) continue;
    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,.94)'; ctx.strokeText(p.t,p.x,p.y);
    ctx.fillStyle=NATIONAL_CHIBAN_COLOR; ctx.fillText(p.t,p.x,p.y);
    if(++n>=NATIONAL_CHIBAN_LABEL_MAX) break;
  }
  ctx.restore();
  const r=creditBox();
  const localOn=(typeof jibanSets==='function' && jibanSets().length);
  const y=r.y-r.h-2-(localOn?r.h+2:0);
  ctx.save(); ctx.font='11px system-ui, sans-serif';
  const w=Math.min(W-8,ctx.measureText(NATIONAL_CHIBAN_CREDIT).width+8);
  ctx.fillStyle='rgba(255,255,255,.84)'; ctx.fillRect(4,y,w,r.h);
  ctx.fillStyle='#333'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(NATIONAL_CHIBAN_CREDIT,8,y+r.h/2); ctx.restore();
}

function nationalJibanHintHtml(){
  if(!nationalJibanEnabled() || !NC.last || NC.last.test) return '';
  if(NC.last.tooFar) return '法務局地番図はもっと拡大すると表示します<span class="sub">オンライン・公共座標の区域</span>';
  if(NC.last.loading && !NC.last.features) return '法務局地番図を読み込み中<span class="sub">初回は通信が必要です</span>';
  if(NC.last.errors && !NC.last.features) return '法務局地番図を読み込めません<span class="sub">通信状態を確認してください</span>';
  if(NC.last.requested && NC.last.ready===NC.last.requested && !NC.last.features)
    return 'この場所には重ねられる法務局地番図がありません<span class="sub">任意座標の区域は地図XMLを取り込んで位置合わせ</span>';
  return '';
}

function nationalJibanLayerHtml(){
  const on=nationalJibanEnabled(), s=NC.last;
  let info='オンライン';
  if(on&&s){
    if(s.tooFar) info='拡大して表示';
    else if(s.loading&&!s.features) info='読込中';
    else if(s.errors&&!s.features) info='通信エラー';
    else if(s.features) info=s.features+'筆';
    else if(s.ready) info='この場所は未収録';
  }
  return `<div class="listRow">
    <button type="button" class="del" style="background:${on?'#e7f0fb':'#f0f0f0'};color:${on?'#1e73d2':'#999'};min-width:52px;"
      onclick="toggleLayer('nationalJiban')">${on?'表示':'非表示'}</button>
    <span class="layerCol" style="background:${NATIONAL_CHIBAN_COLOR}" title="法務局地番図の色"></span>
    <span style="flex:1">法務局地番図（事前取込不要）</span><span class="coords">${esc(info)}</span></div>
  <div class="noteBox" style="margin:0 0 8px;font-size:12.5px;line-height:1.55;">
    表示にすると、現在地周辺だけを通信で読み込みます。法務省データのうち<b>公共座標で重ねられる区域</b>が対象です。境界確定・登記の証明には使えません。
  </div>`;
}

window.addEventListener('online',()=>{
  for(const [k,r] of NC.tiles) if(r.state==='offline'||r.state==='error') NC.tiles.delete(k);
  if(nationalJibanEnabled()) draw();
});
