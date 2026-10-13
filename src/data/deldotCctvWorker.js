/**
 * Public DelDOT camera HLS adapter for Cloudflare Pages.
 *
 * A source can only be a fixed DelDOT /live/KCAM....stream path, never a
 * user-controlled host or URL. Live streams are transient and not recorded.
 */
const API = 'https://tmc.deldot.gov/json/videocamera.json';
const VIDEO_HOST = 'https://video.deldot.gov';
const FALLBACK_CAMERAS = [
  ['KCAM001','DE 1 @ Milford Neck Road',38.990931,-75.448625],
  ['KCAM002','W North St @ West Dover Connector',39.153462,-75.542016],
  ['KCAM003','US 13 SB @ West Dover Connector',39.124642,-75.532336],
  ['KCAM004','US 13 @ RD 88',39.180998,-75.529771],
  ['KCAM005','New Burton Rd S @ West Dover Connector',39.129917,-75.54346],
  ['KCAM020','US 13 @ Harrington Fair Rd',38.908166,-75.569731]
];
const sendJson = (body,status=200) => new Response(JSON.stringify(body),{
 status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
});
function hash(text) {
 let n=2166136261;for(const ch of text){n^=ch.charCodeAt(0);n=Math.imul(n,16777619)}
 return n>>>0;
}
export function makeDelDotCamera(row,prior=false){
 const id=String(row.id||'').toUpperCase();
 if(!/^KCAM\d{3,5}$/.test(id)||String(row.status||'').toLowerCase()!=='active')return null;
 const lat=Number(row.lat),lon=Number(row.lon);
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<38.4||lat>39.9||lon< -75.85||lon> -75)return null;
 if(!prior){
  try{
   const url=new URL(String(row.urls?.m3u8s||''));
   if(url.protocol!=='https:'||url.hostname!=='video.deldot.gov'||url.username||url.password||
     url.port||url.pathname!==`/live/${id}.stream/playlist.m3u8`)return null;
  }catch{return null}
 }
 const camId=`deldot-${id.toLowerCase()}`;
 return {id:camId,name:String(row.title||id).slice(0,140),
  city:row.county?`${String(row.county).slice(0,60)} County`:'Delaware',
  cityId:'deldot-de',provider:'Delaware Department of Transportation',
  lat,lon,headingDeg:(hash(camId)%16)*22.5,headingConfidence:'low',
  pitchDeg:-18,fovDeg:44,rangeM:145,mountHeightM:8,groundElevationM:10,
  feedType:'hls',sourceKind:prior?'deldot-last-known':'deldot-open-data',
  pack:'deldot',url:`${VIDEO_HOST}/live/${id}.stream/playlist.m3u8`,
  poseSource:'estimated',
  license:'DelDOT public CCTV stream; permission for redistribution not established'};
}
export const fallbackDelDotCameras = () =>
 FALLBACK_CAMERAS.map(([id,title,lat,lon])=>
  makeDelDotCamera({id,title,lat,lon,status:'Active'},true)).filter(Boolean);
export async function loadDelDotCameras(){
 const response=await fetch(API,{redirect: 'manual',headers:{Accept:'application/json'},
  signal:AbortSignal.timeout(13000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('DelDOT catalog HTTP '+response.status)}
 const data=await limited(response,3*1024*1024);
 const raw=JSON.parse(new TextDecoder().decode(data));
 const cameras=(Array.isArray(raw?.videoCameras)?raw.videoCameras:[])
  .map(x=>makeDelDotCamera(x)).filter(Boolean);
 // Active does not guarantee that every individual HLS feed is currently healthy.
 return cameras.slice(0,130);
}
async function limited(res,max){
 if(Number(res.headers.get('content-length')||0)>max)throw Error('upstream too large');
 const reader=res.body?.getReader();if(!reader)throw Error('missing body');
 const chunks=[];let len=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   len+=value.byteLength;
   if(len>max)throw Error('upstream too large');
   chunks.push(value);
  }
  const bytes=new Uint8Array(len);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  return bytes;
 }catch(e){await reader.cancel().catch(()=>{});throw e}
}
const okSegment=name=>typeof name==='string'&&name.length<=180&&
 /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:m3u8|ts|m4s|mp4|aac|key)$/.test(name)&&
 !name.includes('..');
const okLease=value=>/^[0-9a-f-]{36}$/i.test(value||'');
function rewriteManifest(text,id,baseUrl,requestUrl){
 if(!text.startsWith('#EXTM3U'))throw Error('invalid HLS playlist');
 const inUrl=new URL(requestUrl);
 const lease=inUrl.searchParams.get('lease');
 const root=`/live/${id}.stream/`;
 const proxyUri=raw=>{
  let url;
  try{url=new URL(raw,baseUrl)}catch{throw Error('invalid HLS URI')}
  if(url.protocol!=='https:'||url.hostname!=='video.deldot.gov'||url.username||
     url.password||url.port||!url.pathname.startsWith(root))
    throw Error('untrusted HLS URI');
  const file=url.pathname.slice(root.length);
  if(!okSegment(file))throw Error('unsupported HLS URI');
  const params=new URLSearchParams();
  for(const [key,value] of url.searchParams){
   if(/^(?:wowzasessionid|wowzatoken|token|sessionid|_HLS_msn|_HLS_part)$/.test(key) && value.length<=128)
    params.append(key,value);
  }
  if(okLease(lease))params.set('lease',lease);
  return `/api/cctv/media/deldot-${id.toLowerCase()}/${file}${params.size?'?'+params:''}`;
 };
 return text.replace(/\r/g,'').split('\n').map(line=>{
  if(!line.trim())return line;
  if(line.startsWith('#')){
   return line.replace(/URI="([^"]+)"/g,(_whole,raw)=>`URI="${proxyUri(raw)}"`);
  }
  return proxyUri(line.trim());
 }).join('\n');
}
export async function fetchDelDotHls(request,source,file='playlist.m3u8'){
 if(source?.pack!=='deldot'||source.feedType!=='hls'||!okSegment(file))
  return sendJson({error:'invalid_camera_stream'},400);
 const m=/^deldot-(kcam\d{3,5})$/i.exec(source.id);
 if(!m)return sendJson({error:'invalid_camera_id'},400);
 const id=m[1].toUpperCase();
 const upstream = new URL(`${VIDEO_HOST}/live/${id}.stream/${file}`);
 // HLS media-playlist URLs can carry server-issued Wowza session identifiers.
 // Re-forward ONLY the exact safe query keys from the previously rewritten URI.
 for (const [name,value] of new URL(request.url).searchParams) {
   if (/^(?:wowzasessionid|wowzatoken|token|sessionid|_HLS_msn|_HLS_part)$/.test(name) &&
     value.length <= 128) upstream.searchParams.append(name,value);
 }
 const upstreamUrl=upstream.href;
 try{
  const playlist=file.endsWith('.m3u8');
  const response=await fetch(upstreamUrl,{redirect: 'manual',signal:AbortSignal.timeout(14000),
   headers:{Accept:playlist?'application/vnd.apple.mpegurl,*/*':'*/*'}});
  if(!response.ok){
   await response.body?.cancel().catch(()=>{});
   return sendJson({error:'hls_upstream_unavailable',httpStatus:response.status},502);
  }
  const bytes=await limited(response,playlist?256*1024:8*1024*1024);
  if(playlist){
   const text=rewriteManifest(new TextDecoder().decode(bytes),id,upstreamUrl,request.url);
   return new Response(text,{headers:{'content-type':'application/vnd.apple.mpegurl',
    'cache-control':'no-store','x-gev-cctv':'hls-live'}});
  }
  const type=file.endsWith('.ts')?'video/mp2t':file.endsWith('.aac')?'audio/aac':
    file.endsWith('.key')?'application/octet-stream':'video/mp4';
  return new Response(bytes,{headers:{'content-type':type,
    'cache-control':'public, max-age=30','x-gev-cctv':'hls-live'}});
 }catch(e){return sendJson({error:'hls_fetch_failed',reason:e?.message?.slice(0,100)||'unknown'},502)}
}
export async function cctvOriginDiagnostics({request,waitUntil}){
 const store=typeof caches==='undefined'?null:caches.default;
 const key=new Request(new URL(request.url).origin+'/_gev_internal/cctv_diag_20261013_v4');
 if(store){const cached=await store.match(key);if(cached)return cached}
 const targets=[
  ['deldotCatalog',API],
  ['deldotHls',VIDEO_HOST+'/live/KCAM001.stream/playlist.m3u8'],
  ['tallinnStill','https://ristmikud.tallinn.ee/last/cam103.jpg']
 ];
 const entries=await Promise.all(targets.map(async([source,url])=>{
  const started=Date.now();
  try{
   const res=await fetch(url,{redirect: 'manual',signal:AbortSignal.timeout(9000),
    headers:{Range:'bytes=0-1023'}});
   await res.body?.cancel().catch(()=>{});
   return {source,status:res.status,mime:(res.headers.get('content-type')||'').split(';')[0],
    durationMs:Date.now()-started};
  }catch(e){return {source,status:null,error:e?.name==='TimeoutError'?'timeout':'connection_failed',
    errorName:String(e?.name||'unknown').slice(0,30),detail:String(e?.message||'unknown').slice(0,160),
    durationMs:Date.now()-started}}
 }));

 // Verify the *proxy* and its playlist rewrite, not just upstream reachability.
 // Use an official last-known camera ID; the result is a diagnostic, not a
 // guarantee that every camera is online.
 const live= fallbackDelDotCameras()[0];
 const local=new URL('/api/cctv/media/'+live.id,request.url);
 const proxyChecks=[];
 try {
  const resp=await fetchDelDotHls(new Request(local),live);
  const playlist=await resp.text();
  proxyChecks.push({kind:'playlist',status:resp.status,
   mime:(resp.headers.get('content-type')||'').split(';')[0],
   entries:playlist.startsWith('#EXTM3U')?playlist.split('\n').filter(x=>x&&!x.startsWith('#')).length:0,
   error:resp.ok?null:playlist.slice(0,200)});
  if(resp.ok){
   let next=playlist.split('\n').map(x=>x.trim()).find(x=>x&&!x.startsWith('#'));
   // A master playlist points at a media playlist; look one level further.
   if(next && next.includes('.m3u8')){
    const url=new URL(next,local),file=url.pathname.split('/').at(-1);
    const variant=await fetchDelDotHls(new Request(url),live,file);
    const text=await variant.text();
    proxyChecks.push({kind:'variant',path:url.pathname,queryKeys:[...url.searchParams.keys()],status:variant.status,
     mime:(variant.headers.get('content-type')||'').split(';')[0],
     entries:text.startsWith('#EXTM3U')?text.split('\n').filter(x=>x&&!x.startsWith('#')).length:0,
     error:variant.ok?null:text.slice(0,200)});
    if(variant.ok)next=text.split('\n').map(x=>x.trim()).find(x=>x&&!x.startsWith('#'));
    else next=null;
   }
   if(next && /\.(?:ts|m4s|mp4|aac)(?:\?|$)/.test(next)){
    const url=new URL(next,local),file=url.pathname.split('/').at(-1);
    const chunk=await fetchDelDotHls(new Request(url),live,file);
    const bytes=await chunk.arrayBuffer();
    proxyChecks.push({kind:'segment',status:chunk.status,
      mime:(chunk.headers.get('content-type')||'').split(';')[0],
      bytes:chunk.ok?bytes.byteLength:0});
   }
  }
 }catch(e){proxyChecks.push({kind:'proxy-test',error:String(e?.message||'unknown').slice(0,160)})}
 const r=new Response(JSON.stringify({checkedAt:new Date().toISOString(),sources:entries,proxyChecks}),{
  headers:{'content-type':'application/json','cache-control':'public, max-age=180'}});
 if(store)waitUntil(store.put(key,r.clone()).catch(()=>{}));
 return r;
}
