/**
 * NOAA nowCOAST observed weather tiles and manifests on Cloudflare Pages.
 * Fixed, non-user-selectable upstream. Native Fetch / Cache API; no Node server.
 * Metadata and geometry validation reused from the original implementation.
 */
import {
  parseWeatherCapabilities, weatherImageBbox, weatherTileBounds
} from '../../../server/providers/weather.js';

const BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';
const PRODUCTS = {
  lightning: {service:'lightning_detection',layer:'ldn_lightning_strike_density',style:'lightning_density',
    title:'Lightning density · 15 min',coverage:'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution:'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',width:4096,height:2048,ttl:600},
  radar: {service:'weather_radar',layer:'conus_base_reflectivity_mosaic',style:'weather_radar_base_reflectivity',
    title:'CONUS radar reflectivity',coverage:'Contiguous United States; gaps do not establish absence of precipitation.',
    description:'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    attribution:'NOAA/NWS/NESDIS nowCOAST',width:4096,height:2048,ttl:120},
  clouds: {service:'satellite',layer:'global_longwave_imagery_mosaic',style:'reflectance',
    title:'Global satellite infrared',coverage:'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    attribution:'NOAA/NWS/NESDIS nowCOAST',width:2048,height:1024,ttl:120},
  'clouds-regional': {service:'satellite',layer:'goes_longwave_imagery',style:'goes-lir',
    title:'GOES regional satellite infrared',coverage:'GOES East/West regional North American coverage; not a global image.',
    description:'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    attribution:'NOAA/NWS/NESDIS nowCOAST',width:4096,height:2048,ttl:120}
};
const cacheApi = () => typeof caches !== 'undefined' ? caches.default : null;
const json = (body,status=200,ttl=0) => new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json; charset=utf-8',
    'cache-control':ttl?`public, max-age=${ttl}`:'no-store',
    'x-gev-edge':'noaa-weather-worker-1'}
});
function invalid(message) {return json({error:message},400);}
function availableManifest(product, meta) {
  const spec=PRODUCTS[product],time=meta?.times?.at(-1)||null;
  return {
    schemaVersion:1,product,title:spec.title,coverage:spec.coverage,
    description:spec.description,source:'NOAA nowCOAST',attribution:spec.attribution,
    bounds:meta?.bounds??null,times:meta?.times??[],latest:time,time,
    observedAt:time,fetchedAt:meta?.fetchedAt??null,
    stale:!meta,unavailable:!meta,reason:meta?null:'Weather imagery unavailable',
    tileSize:256,maxLevel:6,tilingScheme:'geographic',
    tileTemplate:time?`/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`:null,
    imageUrl:time?`/api/weather/image?product=${product}&time=${encodeURIComponent(time)}`:null,
    imageSize:{width:spec.width,height:spec.height}
  };
}
async function readLimited(response,limit) {
  if (Number(response.headers.get('content-length')||0)>limit) throw Error('NOAA payload too large');
  const reader=response.body?.getReader();
  if (!reader) throw Error('NOAA body absent');
  const parts=[];
  let total=0;
  while (true) {
    const {value,done}=await reader.read();
    if (done) break;
    total+=value.byteLength;
    if (total>limit) {await reader.cancel().catch(()=>{});throw Error('NOAA payload too large');}
    parts.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of parts){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}
async function getMetadata(ctx,product) {
  const cache=cacheApi(),root=new URL(ctx.request.url).origin;
  const key=new Request(`${root}/_gev_internal/noaa_meta_1?product=${encodeURIComponent(product)}`);
  if(cache){const hit=await cache.match(key);if(hit) return hit.json();}
  const spec=PRODUCTS[product];
  const url=`${BASE}${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
  const res=await fetch(url,{redirect:'error',headers:{Accept:'application/xml,text/xml'},
    signal:AbortSignal.timeout(12000)});
  if(!res.ok)throw Error('NOAA metadata unavailable');
  const bytes=await readLimited(res,512*1024);
  const parsed=parseWeatherCapabilities(new TextDecoder().decode(bytes),product);
  const meta={...parsed,fetchedAt:Date.now()};
  if(cache)ctx.waitUntil(cache.put(key,json(meta,200,spec.ttl)).catch(()=>{}));
  return meta;
}
function validTime(raw) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw||''))return false;
  const ts=Date.parse(raw);
  return Number.isFinite(ts)&&Date.now()-ts<=86400_000&&ts<=Date.now()+300000;
}
function validPng(bytes,width,height) {
  if(bytes.byteLength<33)return false;
  const expected=[137,80,78,71,13,10,26,10];
  if(expected.some((b,i)=>bytes[i]!==b))return false;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return view.getUint32(8)===13 &&
    String.fromCharCode(...bytes.slice(12,16))==='IHDR' &&
    view.getUint32(16)===width && view.getUint32(20)===height;
}
export async function onRequest(ctx) {
  const request=ctx.request,u=new URL(request.url);
  if(request.method!=='GET')return json({error:'method_not_allowed'},405);
  const path=u.pathname;
  const mode=path.split('/').at(-1);
  if(!['manifest','image','tile'].includes(mode))return json({error:'not_found'},404);
  const allowed=mode==='manifest'?['product']:mode==='image'?
    ['product','time','size','bbox']:['product','time','size','z','x','y'];
  if(u.search.length>512||[...u.searchParams.keys()].some(k=>
    !allowed.includes(k)||u.searchParams.getAll(k).length!==1))
    return invalid('invalid_weather_query');
  const product=u.searchParams.get('product'),spec=PRODUCTS[product];
  if(!spec)return invalid('unknown_weather_product');
  let box=null, size,coords=null;
  try {
    if(mode==='image')box=weatherImageBbox(u.searchParams.get('bbox'));
    const maxWidth=box?4096:spec.width;
    size=u.searchParams.get('size')??(mode==='image'?`${maxWidth}x${box?2048:spec.height}`:'256');
    if(mode==='image'&&(!['1024x512','2048x1024','4096x2048'].includes(size)||
      Number(size.split('x')[0])>maxWidth))return invalid('invalid_weather_image_size');
    if(mode==='tile'&&!['256','512','1024'].includes(size))return invalid('invalid_weather_tile_size');
    if(mode==='tile'){
      coords=['z','x','y'].map(k=>u.searchParams.get(k));
      if(coords.some(x=>! /^(?:0|[1-9]\d{0,2})$/.test(x||'')))return invalid('invalid_weather_tile');
      box=weatherTileBounds(...coords.map(Number));
    }
  }catch{return invalid('invalid_weather_bounds');}
  let meta;
  try{meta=await getMetadata(ctx,product);}
  catch{
    if(mode==='manifest')return json(availableManifest(product,null),200,30);
    return json({error:'weather_upstream_unavailable'},503);
  }
  if(mode==='manifest')return json(availableManifest(product,meta),200,spec.ttl);
  const time=u.searchParams.get('time');
  if(!validTime(time)||!meta.allowedTimes.includes(time))
    return invalid('unknown_weather_time');
  const image=mode==='image';
  const bounds=box??[meta.bounds.west,meta.bounds.south,meta.bounds.east,meta.bounds.north];
  if(bounds[0]<meta.bounds.west||bounds[1]<meta.bounds.south||
     bounds[2]>meta.bounds.east||bounds[3]>meta.bounds.north)
     return invalid('invalid_weather_bbox');
  const [width,height]=image?size.split('x').map(Number):[Number(size),Number(size)];
  const cache=cacheApi(),key=new Request(u.href);
  if(cache){const hit=await cache.match(key);if(hit)return hit;}
  const upstream=new URL(`${BASE}${spec.service}/ows`);
  upstream.search=new URLSearchParams({service:'WMS',version:'1.1.1',
    request:'GetMap',layers:spec.layer,styles:spec.style,srs:'EPSG:4326',
    bbox:bounds.join(','),width:String(width),height:String(height),
    format:'image/png',transparent:'true',time}).toString();
  try{
    const res=await fetch(upstream.href,{redirect:'error',headers:{Accept:'image/png'},
      signal:AbortSignal.timeout(18000)});
    if(!res.ok||!/^image\/png(?:;|$)/i.test(res.headers.get('content-type')||'')){
      await res.body?.cancel().catch(()=>{});throw Error('NOAA tile unavailable');
    }
    const cap=image?16*1024*1024:Math.max(1024*1024,width*width*4+65536);
    const bytes=await readLimited(res,cap);
    if(!validPng(bytes,width,height))throw Error('NOAA image invalid');
    const result=new Response(bytes,{headers:{'content-type':'image/png',
      'cache-control':'public, max-age=86400, immutable',
      'x-content-type-options':'nosniff','x-gev-edge':'noaa-weather-worker-1'}});
    if(cache)ctx.waitUntil(cache.put(key,result.clone()).catch(()=>{}));
    return result;
  }catch{return json({error:'weather_upstream_unavailable'},503);}
}
