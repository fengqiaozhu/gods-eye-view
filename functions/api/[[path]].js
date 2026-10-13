/**
 * Cloudflare Pages Functions adapter for God's Eye View public feeds.
 * Keep this Worker independent from the local Node/Vite middleware.
 * No user-supplied upstream URLs, no credential reflection, bounded responses.
 * Source: https://github.com/bilawalsidhu/gods-eye-view
 */
import { normalizeAdsbLolPointResponse } from '../../src/data/adsbLolFallback.js';
import { nominatimToGeocodeResult } from '../../src/nominatimGeocode.js';
import { normalizeRegionalWeather } from '../../src/data/regionalModel.js';
import { normalizeRouteProfile, projectRouteResult } from '../../src/data/placeProviderPayloads.js';
import { normalizeOsrmSteps } from '../../src/data/routeSteps.js';

const API_VERSION = 'cf-pages-bridge-1';
const timeout = (ms = 12000) => AbortSignal.timeout(ms);
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const error = (message, status = 503) => json({ error: message }, status);
const bounded = (s, max) => typeof s === 'string' && s.length <= max;
const validPoint = (params, latKey = 'latitude', lonKey = 'longitude') => {
  const a = params.get(latKey), b = params.get(lonKey);
  if (a === null || b === null || !a.trim() || !b.trim()) return null;
  const latitude = Number(a), longitude = Number(b);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
};
const hintHeaders = (ttl, extra = {}) => ({ 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', ...extra });
const sharedCache = () => typeof caches !== 'undefined' ? caches.default : null;

/** Cache safely by incoming URL (never secrets), only 200 responses; limit body size. */
async function cached(ctx, target, { ttl = 60, maxBytes = 5 * 1024 * 1024, type, headers = {}, method = 'GET', body, redirect = 'error', transform, fallbackMessage = 'Upstream unavailable' } = {}) {
  const request = ctx.request;
  const cache = sharedCache();
  const cacheKey = new Request(request.url, { method: 'GET' });
  if (ttl > 0 && method === 'GET' && cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), 'x-gev-cache': 'HIT' } });
  }
  let upstream;
  try {
    upstream = await fetch(target, { method, headers: { accept: '*/*', ...headers }, ...(body === undefined ? {} : { body }), redirect, signal: timeout(18000) });
  } catch {
    return error(fallbackMessage, 502);
  }
  if (!upstream.ok) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return json({ error: fallbackMessage, upstreamStatus: upstream.status }, upstream.status === 429 ? 429 : 502, upstream.status === 429 ? { 'retry-after': upstream.headers.get('retry-after') || '30' } : {});
  }
  const size = Number(upstream.headers.get('content-length') || 0);
  if (size > maxBytes) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return error('Upstream response too large', 502);
  }
  let bytes;
  try {
    bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > maxBytes) return error('Upstream response too large', 502);
  } catch { return error(fallbackMessage, 502); }
  let out = bytes;
  if (transform) {
    try { out = JSON.stringify(await transform(JSON.parse(new TextDecoder().decode(bytes)))); }
    catch { return error('Invalid upstream payload', 502); }
  }
  const response = new Response(out, { status: 200, headers: {
    ...hintHeaders(ttl, { 'content-type': type || (transform ? 'application/json; charset=utf-8' : upstream.headers.get('content-type') || 'application/json; charset=utf-8') }),
    'x-gev-edge': API_VERSION,
    'x-gev-cache': 'MISS'
  } });
  if (ttl > 0 && method === 'GET' && cache) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}
function routeFail(message) { return json({ ok: false, error: message }); }
function haversine(a, b) {
  const r = Math.PI / 180, dlat = (b[1] - a[1]) * r, dlon = (b[0] - a[0]) * r;
  const s = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
async function weather(ctx, point) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: point.latitude.toFixed(5), longitude: point.longitude.toFixed(5),
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility',
    timezone: 'UTC'
  });
  return cached(ctx, u, {
    ttl: 300, maxBytes: 512 * 1024,
    transform: (payload) => {
      const normalized = normalizeRegionalWeather(payload);
      if (!normalized) throw Error('missing weather');
      return { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather: normalized };
    }, fallbackMessage: 'Weather effects unavailable'
  });
}
async function regionFlights(ctx, point, reason) {
  const lat = Math.round(point.latitude * 4) / 4;
  const lon = Math.round(point.longitude * 4) / 4;
  const res = await cached(ctx, `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`, {
    ttl: 15, maxBytes: 5 * 1024 * 1024, transform: normalizeAdsbLolPointResponse,
    fallbackMessage: 'Flight feeds temporarily unavailable'
  });
  const headers = new Headers(res.headers);
  headers.set('x-feed-source', 'adsb.lol');
  headers.set('x-opensky-auth-used', 'regional-fallback');
  headers.set('x-opensky-reason', reason);
  return new Response(res.body, { status: res.status, headers });
}
async function adsbdb(ctx, kind, key) {
  const field = kind === 'route' ? 'callsign' : 'aircraft';
  const response = await cached(ctx, `https://api.adsbdb.com/v0/${field}/${key}`, {
    ttl: 86400, maxBytes: 512 * 1024,
    transform(payload) {
      if (kind === 'route') {
        const fr = payload?.response?.flightroute;
        if (!fr?.origin || !fr?.destination) return { found: false };
        const airport = (a) => ({
          code: a.iata_code || a.icao_code || '',
          name: a.municipality || a.name || '',
          lat: Number.isFinite(a.latitude) ? a.latitude : null,
          lon: Number.isFinite(a.longitude) ? a.longitude : null
        });
        return { found: true, airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
      }
      const a = payload?.response?.aircraft;
      return a ? { found: true, typeCode: a.icao_type || null, typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : a.type || null, registration: a.registration || null } : { found: false };
    }, fallbackMessage: 'Aircraft enrichment unavailable'
  });
  // adsbdb uses HTTP 404 for absent aircraft: absence is not a service failure.
  if (response.status === 502 && response.headers.get('content-type')?.includes('json')) return json({ found: false });
  return response;
}
async function routing(ctx, params) {
  const profile = normalizeRouteProfile((params.get('profile') || 'foot').toLowerCase());
  if (!profile) return routeFail('invalid profile');
  const pairs = (params.get('coords') || '').split(';').map(s => s.trim()).filter(Boolean);
  if (pairs.length < 2 || pairs.length > 12) return routeFail('need 2-12 coordinates');
  const pts = pairs.map(pair => pair.split(',').map(Number));
  if (pts.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) return routeFail('invalid coordinate');
  let distance = 0;
  for (let i = 1; i < pts.length; i++) {
    const km = haversine(pts[i - 1], pts[i]);
    if (km > 600) return routeFail('route leg too long');
    distance += km;
  }
  if (distance > 2500) return routeFail('route too long');
  const withSteps = params.get('steps') === '1';
  const coords = pts.map(p => p.join(',')).join(';');
  const upstreamProfile = profile === 'car' ? 'driving' : profile;
  const target = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${upstreamProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=${withSteps ? 'true' : 'false'}`;
  return cached(ctx, target, {
    ttl: 600, maxBytes: 8 * 1024 * 1024,
    transform: (data) => {
      const route = data?.routes?.[0];
      if (data?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return { ok: false, error: 'no route found' };
      const result = projectRouteResult(route, profile);
      if (withSteps) {
        const normalized = normalizeOsrmSteps(route);
        result.steps = normalized.steps;
        if (normalized.truncated) result.stepsTruncated = true;
      }
      return result;
    }, fallbackMessage: 'Route source unavailable'
  });
}
export async function onRequest(ctx) {
  const request = ctx.request, u = new URL(request.url);
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const params = u.searchParams;
  if (path === '/api/edge-health') return json({
    status: 'ok', runtime: 'cloudflare-pages-functions', version: API_VERSION,
    integrations: ['military','flights','celestrak','launches','adsbdb','routes','weather-effects','geocode','mapillary-status','military-tracks','aircraft-tracks']
  });
  if (request.method !== 'GET') return error('Method Not Allowed', 405);
  if (path === '/api/military') {
    const res = await cached(ctx, 'https://api.adsb.lol/v2/mil', { ttl: 12, maxBytes: 8 * 1024 * 1024, fallbackMessage: 'Military aircraft feed unavailable' });
    const h = new Headers(res.headers); h.set('x-feed-source', 'adsb.lol');
    return new Response(res.body, { status: res.status, headers: h });
  }
  if (path === '/api/military/track') {
    const hex = (params.get('hex') || '').toLowerCase();
    if (!/^[0-9a-f~]{6,7}$/.test(hex)) return error('invalid hex', 400);
    return cached(ctx, `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`, { ttl: 60, maxBytes: 5 * 1024 * 1024, fallbackMessage: 'Military track unavailable' });
  }
  if (path === '/api/flights') {
    const point = validPoint(params, 'lat', 'lon');
    // Prefer a bounded point snapshot without credentials. Global anonymous OpenSky
    // is frequently rate-limited and consumes shared public credits.
    if (point) return regionFlights(ctx, point, 'anonymous_regional_feed');
    const res = await cached(ctx, 'https://opensky-network.org/api/states/all?extended=1', { ttl: 90, maxBytes: 12 * 1024 * 1024, fallbackMessage: 'OpenSky feed unavailable' });
    const h = new Headers(res.headers); h.set('x-feed-source', 'OpenSky Network'); h.set('x-opensky-auth-used', 'anon');
    return new Response(res.body, { status: res.status, headers: h });
  }
  if (path === '/api/flights/track') {
    const hex = (params.get('icao24') || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return error('icao24 must be a 6-char hex string', 400);
    return cached(ctx, `https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`, { ttl: 60, maxBytes: 5 * 1024 * 1024, fallbackMessage: 'OpenSky track unavailable' });
  }
  if (path.startsWith('/api/celestrak/')) {
    const group = path.slice('/api/celestrak/'.length);
    if (!/^[a-z0-9-]{1,40}$/i.test(group)) return error('invalid group', 400);
    const upstream = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    return cached(ctx, upstream, { ttl: 21600, maxBytes: 8 * 1024 * 1024, type: 'text/plain; charset=utf-8', fallbackMessage: 'CelesTrak TLE unavailable' });
  }
  if (path === '/api/launches') {
    const end = new Date(), start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.search = new URLSearchParams({ net__gte: start.toISOString(), net__lte: end.toISOString(), limit: '100', mode: 'detailed' });
    return cached(ctx, url, { ttl: 900, maxBytes: 12 * 1024 * 1024, headers: ctx.env.LL2_API_TOKEN ? { Authorization: `Token ${ctx.env.LL2_API_TOKEN}` } : {}, fallbackMessage: 'Launch Library 2 unavailable' });
  }
  if (path.startsWith('/api/adsbdb/')) {
    const m = /^\/api\/adsbdb\/(route|type)\/([a-zA-Z0-9]+)$/.exec(path);
    if (!m) return error('invalid enrichment path', 400);
    const key = m[2];
    if (m[1] === 'route' && !/^[a-z0-9]{2,8}$/i.test(key)) return error('invalid callsign', 400);
    if (m[1] === 'type' && !/^[a-f0-9]{6}$/i.test(key)) return error('invalid hex', 400);
    return adsbdb(ctx, m[1], key.toUpperCase());
  }
  if (path === '/api/weather-effects') {
    const point = validPoint(params);
    return point ? weather(ctx, point) : error('Valid latitude and longitude are required', 400);
  }
  if (path === '/api/route') return routing(ctx, params);
  if (path === '/api/geocode') {
    const q = (params.get('q') || '').trim();
    if (!q || q.length > 200) return error('A place query of 1-200 characters is required', 400);
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '1', 'accept-language': 'en' });
    return cached(ctx, url, { ttl: 3600, maxBytes: 512 * 1024,
      headers: { 'User-Agent': 'gods-eye-view-cloudflare/1.0 (+https://github.com/fengqiaozhu/gods-eye-view)', Referer: 'https://github.com/fengqiaozhu/gods-eye-view' },
      transform: rows => { const hit = nominatimToGeocodeResult(Array.isArray(rows) ? rows[0] : null); return hit ? { status: 'OK', results: [hit] } : { status: 'ZERO_RESULTS', results: [] }; },
      fallbackMessage: 'Place search unavailable'
    });
  }
  if (path === '/api/mapillary/status') return json({ configured: Boolean(ctx.env.MAPILLARY_CLIENT_TOKEN) });
  if (path === '/api/tomtom/status') return json({ hasKey: Boolean(ctx.env.TOMTOM_API_KEY), dailyCount: 0, budget: 0, date: new Date().toISOString().slice(0, 10) });
  if (path === '/api/firms/status') return json({ hasKey: Boolean(ctx.env.FIRMS_MAP_KEY), lastFetch: null, count: 0, stale: true, ttlMs: 0, transactions: null });
  if (path === '/api/realtime/oauth-status') return json({ available: false, reason: 'Cloudflare Workers do not support local Codex login' });
  return json({ error: 'Endpoint not yet migrated to Cloudflare Pages Functions', path, version: API_VERSION }, 501, { 'x-gev-edge': API_VERSION });
}
