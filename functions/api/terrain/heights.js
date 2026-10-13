/**
 * Re:Earth terrain-height adapter for Cloudflare Pages.
 * A bounded per-request fan-out replaces Node's filesystem cache.
 */
import { parseTerrainPoints, terrainPointKey, validTerrainResult } from '../../../src/data/terrainHeightsProxy.js';

const send = (body, status = 200, ttl = 0) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
    'x-gev-edge': 'terrain-height-worker-1' }
});

export async function onRequest({ request, waitUntil }) {
  if (request.method !== 'GET') return send({ error: 'Method Not Allowed' }, 405);
  const raw = new URL(request.url).searchParams.get('points');
  if (!raw || raw.length > 15000) return send({ error: 'invalid points parameter' }, 400);
  const points = parseTerrainPoints(raw);
  if (!points || !points.length ||
      points.some(([lon,lat]) => Math.abs(lon)>180 || Math.abs(lat)>90)) {
    return send({ error: 'invalid points parameter' }, 400);
  }
  // An Edge invocation should not monopolize Re:Earth or time out on huge batches.
  if (points.length > 256) return send({ error: 'too many points; max 256 per request' }, 413);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(request.url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const unique = [...new Set(points.map(terrainPointKey))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 32) chunks.push(unique.slice(i, i + 32));
  try {
    const results = new Map();
    // At most 4 concurrent upstream calls; fast failure does not fabricate heights.
    for (let offset = 0; offset < chunks.length; offset += 4) {
      const batch = await Promise.all(chunks.slice(offset, offset + 4).map(async (chunk) => {
        const upstream = new URL('https://terrain.reearth.land/heights.json');
        upstream.searchParams.set('points', chunk.join(';'));
        const response = await fetch(upstream, { redirect: 'manual', signal: AbortSignal.timeout(25000) });
        if (!response.ok) throw Error('terrain upstream unavailable');
        if (Number(response.headers.get('content-length') || 0) > 512 * 1024) throw Error('upstream too large');
        const text = await response.text();
        if (text.length > 512 * 1024) throw Error('upstream too large');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed?.results) || parsed.results.length !== chunk.length) throw Error('malformed terrain data');
        return chunk.map((key, i) => [key, parsed.results[i]]);
      }));
      for (const rows of batch) for (const [k, v] of rows) {
        if (!validTerrainResult(v)) throw Error('missing terrain datum');
        results.set(k, v);
      }
    }
    const output = points.map(p => results.get(terrainPointKey(p)));
    if (output.some(v => !validTerrainResult(v))) throw Error('incomplete heights');
    const result = send({ results: output }, 200, 86400);
    if (cache) waitUntil(cache.put(key, result.clone()).catch(() => {}));
    return result;
  } catch {
    return send({ error: 'terrain heights fetch failed and no cache available for every point' }, 502);
  }
}
