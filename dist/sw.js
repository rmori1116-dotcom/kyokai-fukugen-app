/* 境界復元支援アプリ（地理院地図版） - オフライン用 Service Worker
   fukugen-map.html と同じフォルダに置いてください。
   アプリ本体（HTML）をキャッシュし、圏外でも起動できるようにします。 */
'use strict';
const CACHE = 'fukugen-map-667502653e00';
/* 置くファイル名（index.html / fukugen-map.html など）に依存しないよう、
   ここではフォルダのトップだけを控え、実際に開かれたURLはアプリ側から通知してもらう。 */
const SHELL = ['./'];

self.addEventListener('install', e=>{
  e.waitUntil((async ()=>{
    const c = await caches.open(CACHE);
    // 取得できない配置でも失敗しないよう個別に扱う
    await Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>{})));
    await self.skipWaiting();
  })());
});

/* アプリ本体から「自分のURL」を受け取り確実にキャッシュする。
   初回訪問時のページ取得は Service Worker を経由しないため、これが無いと
   ファイル名によっては圏外での初回起動に失敗する。 */
self.addEventListener('message', e=>{
  const d = e.data||{};
  if(d.type!=='cache-self' || !d.url) return;
  e.waitUntil((async ()=>{
    try{
      const c = await caches.open(CACHE);
      await c.add(new Request(d.url, {cache:'reload'}));
      if(e.source) e.source.postMessage({type:'cached', url:d.url});
    }catch(err){}
  })());
});

self.addEventListener('activate', e=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    // 別サイトなので、このアプリのキャッシュだけを片づける
    await Promise.all(keys.filter(k=>k.startsWith('fukugen-map-') && k!==CACHE)
                          .map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

/* キャッシュ優先＋裏で更新（stale-while-revalidate）。
   現場では電波が弱い場所でも即座に開けることが最優先なので、
   まずキャッシュを返し、通信できる場合のみ裏で新しい内容を取り込む。
   新しい内容はアプリ側（Service Workerの更新検知）で案内する。 */
self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // 外部リソースは扱わない
  e.respondWith((async ()=>{
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, {ignoreSearch:true});
    const net = fetch(req).then(res=>{
      if(res && res.ok) cache.put(req, res.clone()).catch(()=>{});
      return res;
    }).catch(()=>null);
    if(hit){ e.waitUntil(net); return hit; }
    const res = await net;
    if(res) return res;
    // ナビゲーション要求は控えてあるアプリ本体で代替する（保険）
    if(req.mode==='navigate'){
      for(const u of SHELL){
        const shell = await cache.match(u);
        if(shell) return shell;
      }
    }
    return new Response('オフラインです', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
  })());
});
