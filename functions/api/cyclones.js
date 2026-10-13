/**
 * NOAA NHC / CPHC cyclone observations for Cloudflare Pages.
 * Normalization is shared with the upstream project; no Node services required.
 */
import { parseCycloneStatus, attachCycloneGeometry } from '../../server/providers/cyclones.js';

const STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const GIS = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const LAYERS = [
  { id: 5, cap: 512 * 1024, count: 500, kind: 'points' },
  { id: 6, cap: 512 * 1024, count: 32, kind: 'track' },
  { id: 7, cap: 2 * 1024 * 1024, count: 32, kind: 'cone' }
];
const send = (data, ttl = 0) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
    'x-gev-edge': 'cyclone-worker-1' }
});
async function fetchJson(url, cap) {
  const res = await fetch(url, { redirect: 'manual', headers: { Accept: 'application/geo+json,application/json' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw Error('NOAA unavailable');
  if (Number(res.headers.get('content-length') || 0) > cap) throw Error('NOAA too large');
  const text = await res.text();
  if (text.length > cap) throw Error('NOAA too large');
  return JSON.parse(text);
}
export async function onRequest({ request, waitUntil }) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', {status:405});
  if (new URL(request.url).search) return new Response('Invalid query', {status:400});
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(request.url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const empty = { schemaVersion: 1, source:'NOAA NHC / CPHC',
    attribution:'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
    coverage:'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
    fetchedAt:null, stale:true, unavailable:true, reason:'Cyclone data unavailable', storms:[] };
  try {
    let storms = parseCycloneStatus(await fetchJson(STATUS_URL, 128*1024));
    if (storms.length) {
      try {
        const collections = await Promise.all(LAYERS.map(async layer => {
          const url = new URL(`${GIS}/${layer.id}/query`);
          url.search = new URLSearchParams({
            where:'1=1',
            outFields:layer.kind === 'points' ? 'idp_source,advisnum,tau,maxwind,gust' : 'idp_source,advisnum',
            outSR:'4326', resultRecordCount:String(layer.count), geometryPrecision:'4', f:'geojson'
          });
          return fetchJson(url, layer.cap);
        }));
        storms = attachCycloneGeometry(storms, collections);
      } catch { storms = storms.map(s => ({ ...s, geometryStatus:'unavailable' })); }
    }
    const result = send({ ...empty, fetchedAt:Date.now(), stale:false, unavailable:false, reason:null, storms }, 300);
    if (cache) waitUntil(cache.put(key, result.clone()).catch(() => {}));
    return result;
  } catch { return send(empty, 60); }
}
