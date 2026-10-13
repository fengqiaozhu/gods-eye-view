/**
 * Cloudflare Pages CCTV subset: Austin, Caltrans and TfL public stills.
 *
 * Intentional constraints:
 * - No arbitrary target URL can be supplied by a caller.
 * - No video/HLS or local hardware integrations.
 * - Camera poses are coarse estimated priors; never claim live calibration.
 * - Upstream endpoints match the upstream Node implementation.
 */
import {
  DEFAULT_AUSTIN_ROWS_URL, CALTRANS_CCTV_URL, TFL_JAMCAM_URL,
  TFL_IMAGE_ORIGIN, CALTRANS_ANCHORS, AUSTIN_DOWNTOWN, LONDON_CENTER
} from '../../../server/providers/cctv/constants.js';
import {
  rowArrayToObject, extractAustinCameraId, extractAustinCoords,
  extractAustinHeading, extractAustinName, isLikelyAustinCoordinate,
  fallbackHeadingFromId, prioritizeSources
} from '../../../server/providers/cctv/normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';
import { tallinnPublicCameras } from '../../../src/data/tallinnPublicCameras.js';

const cacheApi = () => typeof caches !== 'undefined' ? caches.default : null;
const output = (body, status = 200, ttl = 0) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
    'x-gev-edge': 'cctv-stills-1'
  }
});
const isFiniteCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const asNum = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const cameraPose = (heading) => {
  const has = Number.isFinite(heading);
  return {headingConfidence: has ? 'high' : 'low',
    pitchDeg: has ? -24 : -18, fovDeg: has ? 56 : 44,
    rangeM: has ? 210 : 145, mountHeightM: has ? 10 : 8};
};
async function requestJson(url, maxBytes) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(14000)
  });
  if (!res.ok) throw Error('camera catalog unavailable');
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw Error('camera catalog too large');
  const text = await res.text();
  if (text.length > maxBytes) throw Error('camera catalog too large');
  return JSON.parse(text);
}
async function austin() {
  const data = await requestJson(DEFAULT_AUSTIN_ROWS_URL, 16 * 1024 * 1024);
  const cols = data?.meta?.view?.columns || [];
  const rows = data?.data || [];
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];
  const cameras = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const r = rowArrayToObject(row, cols);
    const id = extractAustinCameraId(r);
    if (!id || !/^[a-z0-9_.-]{1,80}$/i.test(id)) continue;
    const status = String(r.camera_status || '').trim().toUpperCase();
    if (status && status !== 'TURNED_ON') continue;
    const { lat, lon } = extractAustinCoords(r);
    if (!isLikelyAustinCoordinate(lat, lon)) continue;
    const heading = extractAustinHeading(r);
    const sourceUrl = `https://cctv.austinmobility.io/image/${encodeURIComponent(id)}.jpg`;
    cameras.push({ id, name: extractAustinName(r,id), city:'Austin', cityId:'austin',
      provider:'Austin Transportation & Public Works',lat,lon,
      headingDeg: Number.isFinite(heading) ? heading : fallbackHeadingFromId(id),
      ...cameraPose(heading), groundElevationM: 150, feedType:'image',
      sourceKind:'austin-open-data', license:'Public city traffic camera frame',
      pack:'austin',url:sourceUrl });
  }
  return prioritizeSources([...new Map(cameras.map(c=>[c.id,c])).values()], 120, [AUSTIN_DOWNTOWN]);
}
async function caltrans() {
  const districts = [4,7,11,3];
  const settled = await Promise.allSettled(districts.map(async district => ({
    district, data:await requestJson(CALTRANS_CCTV_URL(district), 8 * 1024 * 1024)
  })));
  const cameras = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { district, data } = s.value;
    for (const row of Array.isArray(data?.data) ? data.data : []) {
      const c = row?.cctv, loc = c?.location || {};
      if (!c || String(c.inService).toLowerCase() !== 'true') continue;
      const lat = asNum(loc.latitude), lon = asNum(loc.longitude);
      if (!isFiniteCoord(lat,lon) || lat < 32 || lat > 42 || lon < -125 || lon > -114) continue;
      const sourceUrl = String(c.imageData?.static?.currentImageURL || '');
      if (!sourceUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;
      const name = String(loc.locationName || '').trim();
      const m = /^([A-Za-z0-9_-]+)\s*--/.exec(name);
      const code = (m ? m[1] : `x${cameras.length}`).toLowerCase();
      const id = `ca-d${district}-${code}`;
      const heading = directionToHeading(loc.direction, true);
      const heightFt = asNum(loc.elevation);
      cameras.push({ id, name:name.replace(/^[A-Za-z0-9_-]+\s*--\s*/, '') || id,
        city:String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId:`ca-d${district}`, provider:'Caltrans', lat, lon,
        headingDeg:Number.isFinite(heading) ? heading : fallbackHeadingFromId(id),
        ...cameraPose(heading),
        groundElevationM:Number.isFinite(heightFt) ? Math.max(-100,Math.min(4000,heightFt*0.3048)) : 150,
        feedType:'image', sourceKind:'caltrans-open-data', pack:'caltrans',
        license:'Public Caltrans highway camera frame', url:sourceUrl });
    }
  }
  return prioritizeSources(cameras, 180, CALTRANS_ANCHORS);
}
async function tfl() {
  const rows = await requestJson(TFL_JAMCAM_URL, 5 * 1024 * 1024);
  if (!Array.isArray(rows)) return [];
  const cameras = [];
  for (const place of rows) {
    const props = Object.fromEntries((place?.additionalProperties || [])
      .filter(p=>typeof p?.key === 'string').map(p=>[p.key,p.value]));
    if (String(props.available).toLowerCase() !== 'true') continue;
    const lat = asNum(place.lat), lon = asNum(place.lon);
    if (!isFiniteCoord(lat,lon) || lat < 51 || lat > 52 || lon < -1 || lon > 0.5) continue;
    const sourceUrl = String(props.imageUrl || '');
    if (!sourceUrl.startsWith(TFL_IMAGE_ORIGIN)) continue;
    const rawId = String(place?.id || '').replace(/^JamCams_/, '');
    if (!/^[A-Za-z0-9_.-]{2,80}$/.test(rawId)) continue;
    const id = `tfl-${rawId}`;
    cameras.push({ id, name:String(place.commonName || `JamCam ${rawId}`),
      city:'London', cityId:'london',provider:'Transport for London',
      lat,lon,headingDeg:fallbackHeadingFromId(id),headingConfidence:'low',
      pitchDeg:-18,fovDeg:44,rangeM:145,mountHeightM:8,groundElevationM:15,
      feedType:'image',sourceKind:'tfl-open-data',
      license:'Powered by TfL Open Data',pack:'tfl',url:sourceUrl });
  }
  return prioritizeSources(cameras, 140, [LONDON_CENTER]);
}
function catalogKey(request) {
  const url = new URL(request.url);
  return new Request(url.origin + '/_gev_internal/cctv_catalog_20261013');
}
async function getCatalog(ctx) {
  const cache = cacheApi(), key = catalogKey(ctx.request);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const results = await Promise.allSettled([austin(),caltrans(),tfl()]);
  // The upstream project's vetted Tallinn catalog is present even when every
  // external public camera API is unreachable from a Cloudflare POP.
  const sources = tallinnPublicCameras.map(x => ({...x}));
  const seen = new Set(sources.map(x => x.id));
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const camera of result.value) {
      if (seen.has(camera.id)) continue;
      seen.add(camera.id);
      sources.push(camera);
    }
  }
  const payload = { sources, trimmedPacks:[], collectedAt:Date.now() };
  if (cache && sources.length) ctx.waitUntil(cache.put(key, output(payload,200,900)).catch(()=>{}));
  return payload;
}
function publicCamera(source) {
  const { url, ...fields } = source;
  return {
    ...fields, poseSource:'estimated', credit:'',
    code:'', groundHeights:null
  };
}
function secureImageUrl(source) {
  if (!source || source.feedType !== 'image') return false;
  let u;
  try { u = new URL(source.url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
  if (source.pack === 'austin') return u.hostname === 'cctv.austinmobility.io' && /^\/image\/[a-zA-Z0-9_.%-]+\.jpg$/.test(u.pathname);
  if (source.pack === 'caltrans') return u.hostname === 'cwwp2.dot.ca.gov' && u.pathname.startsWith('/data/');
  if (source.pack === 'tfl') return source.url.startsWith(TFL_IMAGE_ORIGIN);
  if (source.pack === 'tallinn') return u.hostname === 'ristmikud.tallinn.ee' && /^\/last\/cam[0-9]+\.jpg$/.test(u.pathname);
  return false;
}
async function frame(ctx, source) {
  if (!secureImageUrl(source)) return output({error:'camera_source_unavailable'}, 404);
  const cache = cacheApi();
  const bucket = Math.floor(Date.now()/15000);
  const key = new Request(new URL(ctx.request.url).origin +
    `/_gev_internal/cctv_frame/${encodeURIComponent(source.id)}/${bucket}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  try {
    const res = await fetch(source.url, { redirect:'error', signal:AbortSignal.timeout(8000),
      headers:{accept:'image/jpeg,image/png,image/webp'} });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !['image/jpeg','image/png','image/webp'].includes(type) ||
      Number(res.headers.get('content-length') || 0) > 3*1024*1024) {
      await res.body?.cancel().catch(()=>{});
      return output({error:'camera_frame_unavailable'},502);
    }
    const body = await res.arrayBuffer();
    if (!body.byteLength || body.byteLength > 3*1024*1024) return output({error:'camera_frame_unavailable'},502);
    const response = new Response(body,{headers:{
      'content-type':type, 'cache-control':'public, max-age=15',
      'x-content-type-options':'nosniff','x-gev-edge':'cctv-stills-1'
    }});
    if (cache) ctx.waitUntil(cache.put(key,response.clone()).catch(()=>{}));
    return response;
  } catch { return output({error:'camera_frame_unavailable'},502); }
}
export async function onRequest(ctx) {
  const request = ctx.request, path = new URL(request.url).pathname;
  if (request.method !== 'GET') return output({error:'method_not_allowed'},405);
  if (path === '/api/cctv/health') return output({cameras:[]});
  const catalog = await getCatalog(ctx);
  if (path === '/api/cctv/sources') return output({
    sources: catalog.sources.map(publicCamera),
    trimmedPacks: catalog.trimmedPacks
  },200,900);
  const m = /^\/api\/cctv\/(stream|frame|media)\/([A-Za-z0-9_.-]{1,80})$/.exec(path);
  if (!m) return output({error:'unknown_cctv_route'},404);
  const source = catalog.sources.find(x=>x.id === m[2]);
  if (!source) return output({error:'camera_not_found'},404);
  if (m[1] === 'stream') return output({ id:source.id,feedType:'image',
    mediaUrl:null,frameUrl:`/api/cctv/frame/${encodeURIComponent(source.id)}`,
    provider:source.provider,sourceKind:source.sourceKind });
  return frame(ctx,source);
}
