/**
 * Cloudflare Pages Function: public NIFC wildfire perimeters.
 * Supports the same snapshot shape as the Node middleware.
 * Outbound destinations and ArcGIS fields are fixed; never user-selectable.
 */
import { normalizeFirePerimeterSnapshot } from '../../src/layers/perimeters/records.js';

const SERVICE = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';
const FIELDS = [
  'poly_IncidentName','attr_UniqueFireIdentifier','attr_IncidentSize',
  'attr_PercentContained','attr_POOState','attr_IncidentTypeCategory',
  'attr_FireDiscoveryDateTime','poly_DateCurrent','attr_FireCause',
  'attr_FireBehaviorGeneral','attr_TotalIncidentPersonnel','attr_POOCounty',
  'attr_EstimatedCostToDate','attr_IncidentComplexityLevel','attr_CpxName'
].join(',');

const respond = (body, status = 200, ttl = 0) =>
  new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
    'x-gev-edge': 'fire-perimeters-worker-1'
  } });

export async function onRequest({ request, waitUntil }) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  if (new URL(request.url).search) return respond({ error: 'invalid_query' }, 400);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(request.url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  try {
    const features = [];
    for (let page = 0; page < 5; page++) {
      const url = new URL(SERVICE);
      url.search = new URLSearchParams({
        where: '1=1', outFields: FIELDS,
        maxAllowableOffset: '0.001', outSR: '4326', f: 'geojson',
        ...(page ? { resultOffset: String(features.length) } : {})
      });
      const upstream = await fetch(url.href, {
        redirect: 'error', headers: { accept: 'application/geo+json,application/json' },
        signal: AbortSignal.timeout(18000)
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return respond({ error: 'fire_perimeters_unavailable' }, 502);
      }
      const size = Number(upstream.headers.get('content-length') || 0);
      if (size > 16 * 1024 * 1024) return respond({ error: 'fire_perimeters_too_large' }, 502);
      const raw = await upstream.text();
      if (raw.length > 16 * 1024 * 1024) return respond({ error: 'fire_perimeters_too_large' }, 502);
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload.features)) throw Error('invalid wildfire snapshot');
      features.push(...payload.features);
      if (features.length > 10000) throw Error('fire feature limit');
      if (!(payload.exceededTransferLimit || payload.properties?.exceededTransferLimit) || !payload.features.length) break;
    }
    const rows = normalizeFirePerimeterSnapshot({ features });
    if (!rows) throw Error('malformed wildfire snapshot');
    const response = respond({ fetchedAt: Date.now(), rows }, 200, 300);
    if (cache) waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return response;
  } catch {
    return respond({ error: 'fire_perimeters_unavailable' }, 502);
  }
}
