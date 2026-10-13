# Cloudflare Pages deployment (unofficial adapter)

This fork contains a **Cloudflare Pages Functions** implementation for selected Node/Vite proxy endpoints. Its purpose is to host a usable, **keyless** geospatial experience without running a separate Node process. It is not a complete port of the upstream local-first server.

## Cloudflare project

- Repository: `fengqiaozhu/gods-eye-view`
- Framework: Vite / Pages
- Branch: `main`
- Build: `npm run build`
- Output directory: `dist`
- Node build image env: `NODE_VERSION=24.14.0`
- Functions source: `functions/api/`
- Status endpoint: `GET /api/edge-health`

Changes pushed to `main` need to be deployed through Cloudflare Pages Git integration (manually trigger a Pages deployment if Git build events are not dispatched).

## API migration status

| Endpoint | Cloudflare adapter | Notes |
| --- | --- | --- |
| `/api/flights` | ✅ | Regional adsb.lol fallback when `lat` and `lon` supplied; global anonymous OpenSky otherwise |
| `/api/military` | ✅ | adsb.lol; cached |
| `/api/military/track` | ✅ | Bounded aircraft trace |
| `/api/flights/track` | ✅ | OpenSky anonymous endpoint; subject to upstream availability |
| `/api/adsbdb/route/:callsign` | ✅ | Aviation route enrichment |
| `/api/adsbdb/type/:hex` | ✅ | Aircraft type enrichment |
| `/api/celestrak/:group` | ✅ | Satellite TLE; 6-hour edge cache |
| `/api/launches` | ✅ | Launch Library 2; optional `LL2_API_TOKEN` |
| `/api/weather-effects` | ✅ | Open-Meteo current conditions |
| `/api/geocode` | ✅ | Nominatim single-result fallback; avoid public high-volume use |
| `/api/route` | ✅ | Foot/car/bike routing via fixed FOSSGIS endpoints |
| `/api/fire-perimeters` | ✅ | NIFC WFIGS perimeters, ArcGIS |
| `/api/terrain/heights` | ✅* | Re:Earth. Worker bounds each request at **256** points (Node version accepts more); error for larger batches |
| `/api/cyclones` | ✅ | NOAA NHC/CPHC; 5-minute cache; optional geometry |
| `/api/tomtom/status`, `/api/firms/status` | Partial | Only feature status placeholders. No live traffic/fire-heatmap feed |
| `/api/mapillary/status` | Partial | Only reports whether a token is configured; imagery tile proxy not migrated |
| `/api/cctv/sources`, `/health`, `/stream/:id`, `/frame/:id`, `/media/:id` | Partial | Keyless official Austin/Caltrans/TfL online camera catalogs plus 96 vetted bundled Tallinn still cameras (fallback when external catalog APIs are inaccessible); bounded official image frames; HLS/video and other regional catalogs not yet supported |
| `/api/vessels` | ❌ | Long-lived AISStream WebSocket state needs a Durable Object/other persistent consumer, and an AISStream key |
| `/api/overpass` and military installations | ❌ | Multi-query Overpass workload and request governor not ported |
| `/api/weather/*`, `/api/wind/*` | ❌ | NOAA WMS image/tiles and GRIB decoding not ported |
| `/api/transit/*`, `/api/gbfs/*`, `/api/radio/*` | ❌ | Feed-specific policies / cache and transport integrations needed |
| `/api/realtime/token`, `/api/openai/*` | ❌ | Voice/hud credentials, per-user cost controls, and tool orchestration not ported |
| `/api/realtime/oauth-*` | ❌ | Local Codex OAuth cannot run in a stateless Worker |
| `/api/local-receivers/*` | ❌ | Intentionally local-only hardware integration |
| `/api/places/*`, Google Places / Mapillary tiles | ❌ | Server-side secrets and fixed-origin proxy need separate implementation |

Unmigrated API paths respond with HTTP `501` and a JSON error instead of silently returning the SPA's HTML.

## Keys and security

- No keys are needed for the implemented default public feeds.
- If you want higher Launch Library quotas, set `LL2_API_TOKEN` as a secret in **Cloudflare Pages → Settings → Variables and Secrets**.
- Never store a private API key in Vite `import.meta.env` or commit a `.env` file; browser-facing map keys must be provider-restricted.
- All implemented upstream URLs are fixed by code. Unknown paths and invalid coordinate/group/aircraft identifiers are rejected.
- Caching uses Cloudflare's best-effort Cache API, *not* local files or globally consistent durable storage. Edge caches are per-colo and may be evicted.
- For high-volume public sites, geocoding and route calls need a global upstream rate governor (e.g. a Durable Object) to comply with public provider limits.
- Test actual functionality and upstream reachability through your deployment. Successful Pages compilation only verifies that the Worker bundle was accepted, not that every remote feed is reachable.

## Smoke tests

```sh
BASE=https://gods-eye-view-2j5.pages.dev
curl -fsS "$BASE/api/edge-health"
curl -fsS "$BASE/api/mapillary/status"
curl -fsS "$BASE/api/weather-effects?latitude=35.68&longitude=139.76"
curl -fsS "$BASE/api/celestrak/stations" | head
curl -fsS "$BASE/api/military" | head -c 500
curl -fsS "$BASE/api/fire-perimeters" | head -c 500
curl -fsS "$BASE/api/cyclones" | head -c 500
```

## Next migration order

1. Extend CCTV beyond the bundled Tallinn + optional online still-camera catalogs: HLS/video and more regional providers, keeping strict upstream URL allowlists.
2. Overpass / military installations with budgeted queries and consistent cache.
3. NOAA weather WMS layers / wind GRIB transforms.
4. Optional AI voice and private-key proxies with spend limits.
5. AISStream via Durable Object plus durable snapshot/connection model.

Upstream license, provider access policy, request budgets, and keys apply independently of Cloudflare's free allowance.
