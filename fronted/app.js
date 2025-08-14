// ES module app.js — config-driven mock/real toggle + clustering + charts

async function loadConfig() {
  const defaults = { useMock: true, apiBase: 'http://localhost:4000/api/v1' };
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) Object.assign(defaults, await res.json());
  } catch (err) { console.warn('Could not load config.json, using defaults', err); }
  const qs = new URLSearchParams(location.search);
  if (qs.has('mock')) defaults.useMock = qs.get('mock') !== '0';
  if (qs.has('api'))  defaults.apiBase = qs.get('api');
  return defaults;
}
const CONFIG = await loadConfig();
const USE_MOCK = CONFIG.useMock;
const API_BASE = CONFIG.apiBase;
// Ensure `api` exists early to avoid TDZ when referenced below
if (typeof window !== 'undefined') {
  window.api = window.api || {};
}
var api = (typeof window !== 'undefined') ? (window.api = window.api || {}) : (globalThis.api = (globalThis.api || {}));
console.log('Config loaded:', CONFIG);
console.log('%cParking FE Build','color:#fff;background:#007aff;padding:2px 6px;border-radius:4px','no-autoload + 500m radius');
// Ensure a favicon exists to avoid 404 noise in dev
(function ensureFavicon(){
    try{
        if (document.querySelector('link[rel="icon"]')) return;
        const link = document.createElement('link');
        link.rel = 'icon';
        link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="%23007aff"/><text x="32" y="41" font-size="36" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif">P</text></svg>';
        document.head.appendChild(link);
    } catch(e){}
})();
const MAP_DEFAULT = { lat: -37.8136, lng: 144.9631, zoom: 14 };
const SEARCH_RADIUS_METERS = 500; // show parking only within 500 m after a search
const FRONTEND_FORECAST_ONLY = true; // if true, do NOT fetch history from backend; forecast purely on the client
const CAR_CO2_KG_PER_KM = 0.2;

const map = L.map('leaflet').setView([MAP_DEFAULT.lat, MAP_DEFAULT.lng], MAP_DEFAULT.zoom);
// --- Clickable Car-Park Marker Styles & Legend ---
(function injectCarparkStylesAndLegend() {
  const css = `
  .carpark-icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    color:#fff;font-weight:700;box-shadow:0 0 0 2px #fff inset,0 2px 6px rgba(0,0,0,.35); user-select:none;}
  .carpark-icon.available{background:#2ecc71;}   /* green */
  .carpark-icon.low{background:#f39c12;}         /* amber */
  .carpark-icon.full{background:#e74c3c;}        /* red */
  .carpark-legend{background:#fff;padding:6px 8px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.2);font:12px/1.2 Arial;}
  .carpark-legend .row{display:flex;align-items:center;margin:4px 0;}
  .carpark-legend .swatch{width:14px;height:14px;border-radius:50%;margin-right:6px;}
  .swatch.available{background:#2ecc71}.swatch.low{background:#f39c12}.swatch.full{background:#e74c3c}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // Mini legend (bottom-left)
  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'carpark-legend');
      div.innerHTML = `
        <div><strong>Car Parks</strong></div>
        <div class="row"><span class="swatch available"></span><span>Available</span></div>
        <div class="row"><span class="swatch low"></span><span>Limited (&le;20% free)</span></div>
        <div class="row"><span class="swatch full"></span><span>Full</span></div>
        <div class="row" style="margin-top:4px;"><small>Click a marker to view spots</small></div>
      `;
      return div;
    }
  });
  map.addControl(new Legend());
})();

// Utility: choose icon class by free-space ratio
function iconClassFor(p){
  const free = Number(p.available_spots ?? 0);
  const cap  = Math.max(1, Number(p.capacity ?? 0));
  if (free <= 0) return 'full';
  if (free / cap <= 0.2) return 'low';
  return 'available';
}
// Build a Leaflet DivIcon that is clearly clickable
function markerIcon(p){
  return L.divIcon({
    className: '',
    html: `<div class="carpark-icon ${iconClassFor(p)}" title="${p.name} (${p.available_spots}/${p.capacity})">P</div>`,
    iconSize: [28,28],
    iconAnchor: [14,28],
    popupAnchor: [0,-24]
  });
}
// ----- Helpers for Areas (hex polygons) -----
function colorByOcc(rate){
    if (rate < 0.3) return '#2ecc71';   // 绿
    if (rate < 0.6) return '#f1c40f';   // 橙
    return '#e74c3c';                   // 红
}
function toLeafletLatLngs(boundary){
    // 后端 boundary 是 [lng,lat]（GeoJSON 顺序），Leaflet 要 [lat,lng]
    return (boundary || []).map(([lng,lat]) => [lat, lng]);
}
async function showAreaPopup(area){
    try {
        const r = await fetch(`${API_BASE}/parking/areas/${encodeURIComponent(area.area_id)}?lat=${area.center.lat}&lng=${area.center.lng}&radius=1200`, { cache: 'no-store' });
        let detail = area;
        if (r.ok) detail = await r.json();
        const html = `Area ${detail.area_id}<br/>`
            + `Capacity: <strong>${detail.total_bays}</strong><br/>`
            + `Available: <strong>${detail.available_bays}</strong><br/>`
            + `Occupancy: <strong>${Math.round((detail.occupancy_rate||0)*100)}%</strong><br/>`
            + `<small>Updated: ${new Date(detail.updated_at || Date.now()).toLocaleTimeString()}</small>`;
        L.popup().setLatLng([area.center.lat, area.center.lng]).setContent(html).openOn(map);
    } catch (e) { console.warn('Area popup failed', e); }
}
function upsertAreaPolygon(area){
    const id = area.area_id;
    const latlngs = toLeafletLatLngs(area.boundary);
    const style = { color: colorByOcc(area.occupancy_rate||0), fillColor: colorByOcc(area.occupancy_rate||0), weight: 1, fillOpacity: 0.45 };
    if (areaPolygons.has(id)){
        const poly = areaPolygons.get(id);
        poly.setLatLngs(latlngs);
        poly.setStyle(style);
        poly.areaData = area;
        return poly;
    }
    const poly = L.polygon(latlngs, style).addTo(areasLayer);
    poly.areaData = area;
    poly.on('click', () => showAreaPopup(area));
    areaPolygons.set(id, poly);
    return poly;
}

function areaCard(a){
    const div = document.createElement('div');
    div.className = 'lot-card';
    const occPct = Math.round((a.occupancy_rate||0)*100);
    const free = a.available_bays;
    const total = a.total_bays;
    const dist = a._distance_m != null ? `${(a._distance_m/1000).toFixed(2)} km` : '';
    div.innerHTML = `<h4>Area ${a.area_id.slice(0,8)}…</h4>
    <div>
      <span class="badge ${free===0 ? 'red' : ''}">${free}/${total} free</span>
      <span class="badge">Occ ${occPct}%</span>
      <span class="badge">${dist}</span>
    </div>`;
    div.onclick = () => {
        map.setView([a.center.lat, a.center.lng], 17);
        showAreaPopup(a);
    };
    return div;
}
// ----- /Helpers for Areas -----
// --- End styles & legend ---
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 17, showCoverageOnHover: false, spiderfyOnMaxZoom: true, maxClusterRadius: 60 });
map.addLayer(cluster);

const areasLayer = L.layerGroup();
map.addLayer(areasLayer);
const areaPolygons = new Map();

// --- My location layer + locate control ---
const meLayer = L.layerGroup().addTo(map);
let meMarker = null, meCircle = null;

function showMyLocation(lat, lng, accuracy) {
    if (!meMarker) {
        meMarker = L.circleMarker([lat, lng], {
            radius: 7, weight: 2, color: '#007aff', fillColor: '#3da9ff', fillOpacity: 0.9
        }).addTo(meLayer);
    }
    meMarker.setLatLng([lat, lng]);

    if (!meCircle) {
        meCircle = L.circle([lat, lng], {
            radius: Math.max(30, accuracy || 50), weight: 1, color: '#007aff', fillOpacity: 0.08
        }).addTo(meLayer);
    }
    meCircle.setLatLng([lat, lng]);
    if (Number.isFinite(accuracy)) meCircle.setRadius(Math.max(30, accuracy));
}

const Locate = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const a = L.DomUtil.create('a', '', div);
        a.href = '#'; a.title = 'Locate me'; a.innerHTML = '📍';
        L.DomEvent.on(a, 'click', (e) => {
            L.DomEvent.stop(e);
            if (!navigator.geolocation) { console.warn('Geolocation not available'); return; }
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const { latitude, longitude, accuracy } = pos.coords;
                    showMyLocation(latitude, longitude, accuracy);
                    updateDistancesFrom({ lat: latitude, lng: longitude });
                    map.setView([latitude, longitude], Math.max(map.getZoom(), 15));
                },
                (err) => console.warn('Geolocation failed', err),
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
            );
        });
        return div;
    }
});
map.addControl(new Locate());
// --- /My location ---


const markers = new Map();
const statusEl = document.getElementById('status');
const lotListEl = document.getElementById('lotList');
let currentDestination = null;

const searchBox = document.getElementById('searchBox');
const suggestionsEl = document.getElementById('suggestions');
let debounceTimer;

// --- Helper to clear parking UI ---
function clearParkingUI(message) {
    try {
        if (cluster) cluster.clearLayers();
        if (areasLayer) areasLayer.clearLayers();
        if (markers) markers.clear();
        if (lotListEl) lotListEl.innerHTML = '';
        window.__lastParkingItems = [];
        window.__lastAreas = [];
        if (typeof message === 'string' && statusEl) statusEl.textContent = message;
    } catch (_) {}
}
// ---- Area naming: reverse geocode & cache ----

// ===== Naive front-end forecast (no backend dependency) =====
const areaHistoryCache = new Map();   // area_id -> history.series
const areaForecastCache = new Map();  // area_id -> [{ts, expected_available, ...}]
let HAS_AREA_HISTORY_ROUTE = null; // null=unknown, true=supported, false=404 → skip in future

// 注入搜索框错误样式
(function injectSearchErrorStyle(){
    const id = 'search-error-style';
    if (!document.getElementById(id)) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
      #searchBox.input-error {
        border: 1px solid #e74c3c !important;
        box-shadow: 0 0 0 3px rgba(231,76,60,.15);
      }
    `;
        document.head.appendChild(style);
    }
})();

function setSearchError(msg){
    if (statusEl) statusEl.textContent = msg;
    if (searchBox) searchBox.classList.add('input-error');
}
function clearSearchError(){
    if (searchBox) searchBox.classList.remove('input-error');
}
function buildHodFromHistory(series) {
  const buckets = Array.from({length:24}, () => ({sum:0, count:0}));
  if (Array.isArray(series)) {
    for (const r of series) {
      const t = new Date(r.ts);
      if (isNaN(t)) continue;
      const h = t.getUTCHours();
      const tot = Number(r.total || 0);
      const free = Number(r.free || 0);
      const denom = tot > 0 ? tot : Math.max(1, free + Number(r.occ || 0));
      const fr = Math.max(0, Math.min(1, free / denom));
      buckets[h].sum += fr;
      buckets[h].count += 1;
    }
  }
  const mean = new Array(24).fill(null);
  for (let h=0; h<24; h++) {
    mean[h] = buckets[h].count ? (buckets[h].sum / buckets[h].count) : null;
  }
  return mean;
}
function defaultDailyFreeProfile() {
  const a = new Array(24);
  for (let h=0; h<24; h++) {
    a[h] = (h>=7&&h<=9) ? 0.15 : (h>=10&&h<=15) ? 0.4 : (h>=16&&h<=19) ? 0.2 : 0.7;
  }
  return a;
}
// Extremely simple: random, smoothed, and only capped by total capacity
function makeNaiveForecast({
  total = 60,
  hours = 24,
  historySeries = null,   // ignored for pure random mode
  currentAvail = 0,       // used as starting point (optional)
  dow = (new Date()).getDay(),   // ignored
  cbdProximity = 1,              // ignored
  stepMinutes = 60,              // 60 or 30
  params = {}
}) {
  // Tunables for randomness / smoothing
  const P = Object.assign({
    meanRatio: 0.45,     // average free ratio center (0..1)
    volRatio:  0.18,     // volatility as fraction of total capacity
    smooth:    0.55      // 0..1, higher = smoother (EMA blend with previous)
  }, params);

  // Helper: bounded random ~ "soft" normal by summing uniforms
  function randnUnit() {
    // mean 0.5, variance ~ 1/12; convert to approx N(0,1) by central limit (sum 12 uniforms - 6)
    let s = 0;
    for (let i=0; i<12; i++) s += Math.random();
    return s - 6; // ~N(0,1)
  }

  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0
  ));
  const stepMs = Math.max(15, stepMinutes) * 60 * 1000;
  const firstTs = new Date(start.getTime() + stepMs);
  const steps = Math.max(1, Math.round((hours * 60) / stepMinutes));

  const out = [];
  let prev = Math.max(0, Math.min(total, Math.round(currentAvail || Math.round(P.meanRatio * total))));

  for (let i=0; i<steps; i++) {
    // candidate around mean with noise
    const center = P.meanRatio * total;
    const noise  = randnUnit() * (P.volRatio * total);
    let cand = Math.round(center + noise);

    // blend with previous to make it look less jumpy
    cand = Math.round(P.smooth * prev + (1 - P.smooth) * cand);

    // hard bounds [0, total]
    const expected = Math.max(0, Math.min(total, cand));

    out.push({
      ts: new Date(firstTs.getTime() + i * stepMs).toISOString(),
      expected_available: expected,
      free_ratio: total > 0 ? expected / total : 0
    });

    prev = expected;
  }

  return out;
}
async function fetchAreaHistorySeries(areaId, lat, lng, radius=1200) {
    if (FRONTEND_FORECAST_ONLY) return null;
    if (areaHistoryCache.has(areaId)) return areaHistoryCache.get(areaId);

    // 1) Prefer by-coordinate (后端这条是存在的)
    if (lat != null && lng != null) {
        try {
            const url2 = `${API_BASE}/parking/areas/bycoord/history?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}&res=9&source=annual&year=2019`;
            const r2 = await fetch(url2, { cache: 'no-store' });
            if (r2.ok) {
                const j2 = await r2.json();
                const series2 = Array.isArray(j2.series) ? j2.series : [];
                areaHistoryCache.set(areaId, series2);
                return series2;
            }
        } catch (_) {}
    }

    // 2) Fallback: 尝试 areaId 路由；若 404 记忆后跳过
    if (HAS_AREA_HISTORY_ROUTE !== false) {
        try {
            const url1 = `${API_BASE}/parking/areas/${encodeURIComponent(areaId)}/history?source=annual&year=2019&radius=${encodeURIComponent(radius)}${lat&&lng?`&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`:''}`;
            const r1 = await fetch(url1, { cache: 'no-store' });
            if (r1.status === 404) { HAS_AREA_HISTORY_ROUTE = false; }
            if (r1.ok) {
                HAS_AREA_HISTORY_ROUTE = true;
                const j1 = await r1.json();
                const series1 = Array.isArray(j1.series) ? j1.series : [];
                areaHistoryCache.set(areaId, series1);
                return series1;
            }
        } catch (_) {}
    }

    return null;
}
function forecastListHtml(series) {
  // 只展示前 6 小时，避免弹窗太长
    const first6 = (series || []).slice(0, 6);
    const li = first6.map(row => {
    const d = new Date(row.ts);
    const hh = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<li><span>${hh}</span><strong>${row.expected_available}</strong></li>`;
  }).join('');
  return `
    <div class="forecast">
      <div class="muted" style="margin:6px 0 4px;">Next hours (naive)</div>
      <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">
        ${li}
      </ul>
    </div>`;
}
const areaNameCache = new Map();     // area_id → label
const areaDomRefs   = new Map();     // id → { h4 }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function reverseGeocodeName(lat, lng){
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
    const r = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'FIT-5120-melb-parking/1.0 (contact: your-email@example.com)'
        }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.address || {};
    const road = a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.square;
    const hood = a.neighbourhood || a.quarter || a.city_district;
    const suburb = a.suburb || a.town || a.city || a.village;
    return road || hood || suburb || null;
}
function toAreaLabel(name){ return name ? `${name} Area` : null; }
function renameLot(id, newName){
    const m = markers.get(id);
    if (m) {
        m.data.name = newName;
        m.setPopupContent(popupHtml(m.data));
        m.options.title = `${newName} (${m.data.available_spots}/${m.data.capacity})`;
        m.setIcon(markerIcon(m.data));
    }
    const ref = areaDomRefs.get(id);
    if (ref && ref.h4) ref.h4.textContent = newName;
}
async function nameAreas(pseudoLots){
    for (const p of pseudoLots){
        if (areaNameCache.has(p.id)) { renameLot(p.id, areaNameCache.get(p.id)); continue; }
        try {
            const base = await reverseGeocodeName(p.lat, p.lng);
            const label = toAreaLabel(base) || p.name;
            areaNameCache.set(p.id, label);
            renameLot(p.id, label);
        } catch(e){ /* ignore */ }
        await sleep(600); // gentle throttle
    }
}
// ---- /Area naming ----

// Press Enter: prefer local area-name matches; fallback to place search
searchBox.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = (searchBox.value || '').trim();
    if (!q) return;
    try {
        const items = await combinedSearch(q);
        if (!items.length) {
            suggestionsEl.style.display = 'none';
            setSearchError(`No results for "${q}" in Melbourne.`);
            clearParkingUI('No car parks to show. Try another place.');
            return;
        }
        const first = items[0];
        if (first.type === 'area') {
            suggestionsEl.style.display = 'none';
            map.setView([first.lat, first.lng], 17);
            const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
            const found = list.find(p => p.id === first.id);
            if (found) showLotPopup(found);
        } else {
            await chooseDestination({ ...first, type:'place' });
        }
    } catch (err) {
        console.error('Enter search failed:', err);
    }
});
function localAreaMatches(q){
    const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
    const qn = (q || '').toLowerCase();
    const seen = new Set();
    const items = [];
    for (const p of list){
        const pretty = areaNameCache.get(p.id) || p.name || '';
        if (pretty.toLowerCase().includes(qn)){
            if (seen.has(p.id)) continue; seen.add(p.id);
            items.push({ type:'area', id: p.id, name: pretty, lat: p.lat, lng: p.lng });
        }
    }
    return items;
}
async function combinedSearch(q){
    const local = localAreaMatches(q).slice(0, 8);
    let remote = [];
    try { const r = await api.geoSearch(q); remote = (r && r.items) ? r.items.map(it => ({...it, type:'place'})) : []; } catch(_){}
    return [...local, ...remote].slice(0, 8);
}
searchBox.addEventListener('input', (e) => {
  clearSearchError(); // user is changing input, clear previous error
  clearParkingUI('Type a place name to search…');
  const q = e.target.value.trim();
  clearTimeout(debounceTimer);
  if (!q) { suggestionsEl.style.display = 'none'; return; }
  debounceTimer = setTimeout(async () => {
    const items = await combinedSearch(q);
    if (!items.length) {
      suggestionsEl.style.display = 'none';
      setSearchError(`No results for "${q}" in Melbourne.`);
      clearParkingUI('No car parks to show. Try another place.');
      return;
    }
    clearSearchError();
    renderSuggestions(items);
  }, 250);
});


function renderSuggestions(items) {
    suggestionsEl.innerHTML = '';
    if (!items.length) { suggestionsEl.style.display = 'none'; return; }
    for (const it of items) {
        const li = document.createElement('li');
        if (it.type === 'area') {
            li.textContent = `🅿︎ ${it.name}`;
            li.tabIndex = 0;
            li.addEventListener('click', () => {
                clearSearchError();
                suggestionsEl.style.display = 'none';
                map.setView([it.lat, it.lng], 17);
                const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
                const found = list.find(p => p.id === it.id);
                if (found) showLotPopup(found);
            });
            li.addEventListener('keypress', (e) => { if (e.key === 'Enter') li.click(); });
        } else {
            li.textContent = it.name;
            li.tabIndex = 0;
            li.addEventListener('click', () => { clearSearchError(); chooseDestination({ ...it, type:'place' }); });
            li.addEventListener('keypress', (e) => { if (e.key === 'Enter') { clearSearchError(); chooseDestination({ ...it, type:'place' }); } });
        }
        suggestionsEl.appendChild(li);
    }
    suggestionsEl.style.display = 'block';
}

async function chooseDestination(place) {
    // Guard: only accept structured picks (place/area) with valid coordinates.
    if (
        !place ||
        !(['place','area'].includes(place.type)) ||
        !Number.isFinite(place.lat) ||
        !Number.isFinite(place.lng)
    ) {
        suggestionsEl.style.display = 'none';
        setSearchError('Please choose a valid place from the suggestions.');
        clearParkingUI('No car parks to show. Try another place.');
        return;
    }
    suggestionsEl.style.display = 'none';
    clearSearchError();
    searchBox.value = place.name;
    currentDestination = place;

    map.setView([place.lat, place.lng], 16);
    statusEl.textContent = 'Loading nearby parking…';
    clearParkingUI('Loading nearby parking…');

    if (USE_MOCK) {
        const { items } = await api.parkingNear(place.lat, place.lng, SEARCH_RADIUS_METERS);
        window.__lastParkingItems = items.slice();
        for (const it of items) it.distance_m = distanceMeters({ lat: place.lat, lng: place.lng }, it);

        markers.clear(); cluster.clearLayers(); lotListEl.innerHTML = '';
        items.forEach((p) => { upsertMarker(p); lotListEl.appendChild(lotCard(p)); });
        if (cluster.getLayers().length) map.fitBounds(cluster.getBounds(), { padding: [20, 20] });

        statusEl.textContent = items.length ? `Showing ${items.length} car parks near ${place.name}.` : 'No car parks found in this area.';
        renderEnvSuggestions(place, items);
        renderCharts(items);
        subscribeRealtime();
        return;
    }

    // 真实后端：用“区域”接口
    const { items: areas } = await api.areasNear(place.lat, place.lng, SEARCH_RADIUS_METERS, 9, 20, 'mix');
    for (const a of areas) a._distance_m = distanceMeters({ lat: place.lat, lng: place.lng }, { lat: a.center.lat, lng: a.center.lng });
    window.__lastAreas = areas.slice();
    // Enforce 500 m radius on client in case backend ignores `radius`
    const areasInRange = areas.filter(a => Number.isFinite(a._distance_m) && a._distance_m <= SEARCH_RADIUS_METERS);

    // —— 使用聚合后的“停车场”作为 marker 显示 ——
    // 清理旧图层
    markers.clear(); cluster.clearLayers();
    areaPolygons.clear(); areasLayer.clearLayers();
    lotListEl.innerHTML = '';

    // 将区域转为“停车场”伪 lot（便于沿用现有 card/marker 组件）
    const pseudoLots = areasInRange.map((a, i) => ({
      id: a.area_id,
      name: `Parking Area ${i+1}`,           // 也可以改成 `Area ${a.area_id.slice(0,6)}`
      lat: a.center.lat,
      lng: a.center.lng,
      capacity: a.total_bays,
      available_spots: a.available_bays,
      distance_m: a._distance_m,
      updated_at: a.updated_at
    }));

    // 记录到最近列表，供“点击地图找最近”的功能使用
    window.__lastParkingItems = pseudoLots.slice();

    // 渲染 marker 和侧栏卡片
    pseudoLots.forEach(p => { upsertMarker(p); lotListEl.appendChild(lotCard(p)); });

    // 视野适配
    if (cluster.getLayers().length) {
      map.fitBounds(cluster.getBounds(), { padding: [20,20] });
    } else {
      map.setView([place.lat, place.lng], 15);
    }

    // 状态提示（与截图一致风格）
    statusEl.textContent = pseudoLots.length
        ? `Showing ${pseudoLots.length} car parks within ${Math.round(SEARCH_RADIUS_METERS)} m of ${place.name}.`
        : `No car parks found within ${Math.round(SEARCH_RADIUS_METERS)} m. Try a different place.`;

    // 环保与图表直接复用伪 lots
    renderEnvSuggestions(place, pseudoLots);
    renderCharts(pseudoLots);
    await nameAreas(pseudoLots); // rename markers/cards to real street names
}

// Show a popup with up-to-date details for a car park, including naive forecast
async function showLotPopup(p) {
  try {
    // 尝试从后端刷新单点信息（若可用），不影响预测
      // 尝试按“区域”刷新详情；没有也不阻塞
      if (!FRONTEND_FORECAST_ONLY) {
        try {
            const r = await fetch(`${API_BASE}/parking/areas/${encodeURIComponent(p.id)}?lat=${encodeURIComponent(p.lat)}&lng=${encodeURIComponent(p.lng)}&radius=1200`, { cache: 'no-store' });
            if (r.ok) {
                const detail = await r.json();
                const fresh = {
                    id: p.id,
                    name: (window.areaNameCache && areaNameCache.get(p.id)) || p.name,
                    lat: p.lat,
                    lng: p.lng,
                    capacity: Number(detail.total_bays ?? p.capacity ?? 0),
                    available_spots: Number(detail.available_bays ?? p.available_spots ?? 0),
                    updated_at: detail.updated_at || p.updated_at
                };
                p = { ...p, ...fresh };
            }
        } catch (_) {}
      }

    // 取历史（如果拿不到就用默认曲线）
    const hist = FRONTEND_FORECAST_ONLY ? null : await fetchAreaHistorySeries(p.id, p.lat, p.lng, SEARCH_RADIUS_METERS);

    // Always recompute forecast from current availability to avoid stale cached values
    const total = Number(p.capacity || 60);
    const capNowRaw = (p && typeof p.available_spots !== 'undefined') ? Number(p.available_spots) : NaN;
    const capNow = Number.isFinite(capNowRaw) ? capNowRaw : 0;
    // Compute day-of-week and CBD proximity for this point
    const cbd = { lat: -37.8136, lng: 144.9631 };
    const dx = (p.lat - cbd.lat), dy = (p.lng - cbd.lng);
    // crude proximity score: 1.0 in CBD core, ~0.0 in far suburbs
    const d2 = dx*dx + dy*dy;
    const cbdProximity = Math.max(0, Math.min(1, 1 - (d2 / 0.01))); // 0.01 ≈ ~10km^2 box scale
    const dow = (new Date()).getDay();

    let forecast = makeNaiveForecast({
      total,
      hours: 24,
      historySeries: hist,
      capNow,
      dow,
      cbdProximity,
      stepMinutes: 60,
      params: { noiseRatio: 0.03, baseDecay: 0.07, lowAvailExtraDecay: 0.10, lowAvailThreshold: 0.30, minSlack: 1 }
    });

    // Optionally store the latest (already-capped) forecast for display reuse
    if (areaForecastCache && typeof areaForecastCache.set === 'function') {
      areaForecastCache.set(p.id, forecast);
    }

    // Optionally log popup opening
    console.log('[popup-open]', p.name, 'avail', p.available_spots, '/', p.capacity);
    // Debug log for capping
    console.log('[forecast]', { id: p.id, name: p.name, capNow, total, first: forecast[0]?.expected_available });

    const d = p && p.updated_at ? new Date(p.updated_at) : new Date();
    const updatedText = isNaN(d) ? '' : d.toLocaleTimeString();
    const baseHtml = `${p.name}<br/>Availability: <strong>${p.available_spots}/${p.capacity}</strong><br/><small>Updated: ${updatedText}</small>`;
    const fHtml = forecastListHtml(forecast);

    L.popup()
      .setLatLng([p.lat, p.lng])
      .setContent(`${baseHtml}${fHtml}`)
      .openOn(map);
  } catch (e) {
    console.warn('showLotPopup failed', e);
    // 兜底：无预测也照常弹出
      L.popup()
          .setLatLng([p.lat, p.lng])
          .setContent(popupHtml(p))
          .openOn(map);
  }
}

function popupHtml(p) {
    const d = p && p.updated_at ? new Date(p.updated_at) : new Date();
    const updatedText = isNaN(d) ? '' : d.toLocaleTimeString();
    return `${p.name}<br/>Availability: <strong>${p.available_spots}/${p.capacity}</strong><br/><small>Updated: ${updatedText}</small>`;
}
function upsertMarker(p) {
  const html = popupHtml(p);
  if (markers.has(p.id)) {
    const mk = markers.get(p.id);
    mk.setPopupContent(html);
    mk.setIcon(markerIcon(p));
    mk.data = p;
    mk.options.title = `${p.name} (${p.available_spots}/${p.capacity})`;
    return;
  }
  const m = L.marker([p.lat, p.lng], { icon: markerIcon(p), title: `${p.name} (${p.available_spots}/${p.capacity})`, riseOnHover: true })
    .bindPopup(html);
  m.data = p; // store data on marker
  m.on('click', () => showLotPopup(p));
  cluster.addLayer(m);
  markers.set(p.id, m);
}
function lotCard(p) {
  const div = document.createElement('div');
  div.className = 'lot-card';
  div.innerHTML = `<h4>${p.name}</h4>
    <div>
      <span class="badge ${p.available_spots === 0 ? 'red' : ''}">${p.available_spots}/${p.capacity} spots</span>
      <span class="badge">${(p.distance_m/1000).toFixed(2)} km</span>
      ${p.price ? `<span class="badge">${p.price}</span>` : ''}
    </div>`;
  const h4 = div.querySelector('h4');
  const badges = div.querySelectorAll('.badge');
  const distEl = badges[1] || null;
  areaDomRefs.set(p.id, { h4, distEl });
  div.onclick = () => {
    map.setView([p.lat, p.lng], 17);
    showLotPopup(p);
  };
  return div;
}

let mockInterval;
function subscribeRealtime() {
  if (!USE_MOCK) {
    // Example SSE wiring here later
    return;
  }
  if (mockInterval) clearInterval(mockInterval);
  mockInterval = setInterval(() => {
    const updates = api.__mockPushUpdates(Array.from(markers.keys()));
    for (const u of updates) {
      const m = markers.get(u.id);
      if (m) m.setPopupContent(popupHtml(u));
      const cards = Array.from(lotListEl.querySelectorAll('.lot-card'));
      cards.forEach(card => {
        if (card.querySelector('h4').textContent === u.name) {
          const badge = card.querySelector('.badge');
          badge.textContent = `${u.available_spots}/${u.capacity} spots`;
          badge.classList.toggle('red', u.available_spots === 0);
        }
      });
      // Invalidate per-area forecast when live availability changes
      if (areaForecastCache && typeof areaForecastCache.delete === 'function') areaForecastCache.delete(u.id);
      // If the popup for this marker is currently open, close it so the next click rebuilds with fresh data
      if (map && map.closePopup) map.closePopup();
    }
  }, 2500 + Math.random() * 2000);
}

function renderEnvSuggestions(place, lots) {
  const env = document.getElementById('envSuggestions');
  const intro = document.getElementById('envIntro');
  env.innerHTML = '';

  if (!lots.length) {
    intro.textContent = `No car parks found near ${place.name}. Consider public transport, cycling, or walking if suitable.`;
    env.appendChild(envCard('Public transport', 'Use tram/train/bus to avoid parking and reduce congestion.', 'High'));
    return;
  }
  const nearest = lots.slice().sort((a,b) => a.distance_m - b.distance_m)[0];
  const km = nearest.distance_m / 1000;
  const co2 = (km * CAR_CO2_KG_PER_KM).toFixed(2);
  intro.textContent = `Approx. distance to the nearest car park: ${km.toFixed(2)} km. Estimated car CO₂ emissions: ~${co2} kg. Alternatives below:`;

  if (km <= 1.2) {
    env.appendChild(envCard('Walk', 'Distance is short. Walking avoids emissions and parking fees.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Cycle', 'Fast and zero-emission for short trips.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Public transport', 'If a direct service exists, it’s cheaper than parking.', 'High'));
  } else if (km <= 5) {
    env.appendChild(envCard('Cycle', '5 km is comfortable bike range for many riders.', '≈100% CO₂ saved'));
    env.appendChild(envCard('Public transport', 'Likely options available depending on route.', 'High'));
    env.appendChild(envCard('Park & Walk', 'Park slightly further away and walk the last 500–800 m.', 'Some savings'));
  } else {
    env.appendChild(envCard('Public transport', 'Avoid city traffic and parking costs.', 'High'));
    env.appendChild(envCard('Park & Ride', 'Drive to a suburban station, then train/tram to destination.', 'Moderate savings'));
    env.appendChild(envCard('Car share', 'Use shared vehicles to reduce total cars parked.', 'Varies'));
  }
}
function envCard(title, text, impact) {
  const div = document.createElement('div'); div.className = 'env-card';
  div.innerHTML = `<h4>${title}</h4><p>${text}</p><p class="muted">Impact: ${impact}</p>`; return div;
}

let avgOccChart, busyHoursChart;
async function renderCharts(lots) {
  const ctx1 = document.getElementById('avgOccChart');
  const ctx2 = document.getElementById('busyHoursChart');
  if (!(ctx1 instanceof HTMLCanvasElement) || !(ctx2 instanceof HTMLCanvasElement)) {
    console.warn('Charts: canvas elements not found; skipping render.');
    return;
  }
    const g1 = ctx1.getContext && ctx1.getContext('2d');
    const g2 = ctx2.getContext && ctx2.getContext('2d');
    if (!g1 || !g2) {
        console.warn('Charts: 2D context not available; skipping render.');
        return;
    }
  // If using real backend, try to fetch stats from /stats/parking
  if (!USE_MOCK) {
    try {
      const r = await fetch(`${API_BASE}/stats/parking`, { cache: 'no-store' });
      if (r.ok) {
        const stats = await r.json();
        // Average Occupancy from backend
        const labels1 = Array.isArray(stats.averageOccupancy) ? stats.averageOccupancy.map(x => x.carPark) : [];
        const occ1    = Array.isArray(stats.averageOccupancy) ? stats.averageOccupancy.map(x => Number(x.percentage) || 0) : [];
        if (avgOccChart) avgOccChart.destroy();
        avgOccChart = new Chart(ctx1, {
          type: 'bar',
          data: { labels: labels1, datasets: [{ label: 'Occupancy %', data: occ1 }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
        });

        // Busiest Hours from backend
        const labels2 = Array.isArray(stats.busiestHours) ? stats.busiestHours.map(x => x.hour) : [];
        const counts2 = Array.isArray(stats.busiestHours) ? stats.busiestHours.map(x => Number(x.count) || 0) : [];
        if (busyHoursChart) busyHoursChart.destroy();
        busyHoursChart = new Chart(ctx2, {
          type: 'line',
          data: { labels: labels2, datasets: [{ label: 'Cars/hour', data: counts2, tension: 0.35 }] },
          options: { responsive: true, plugins: { legend: { display: false } } }
        });
        return; // done with real stats
      } else {
        console.warn('Stats endpoint returned', r.status, r.statusText);
      }
    } catch (err) {
      console.warn('Failed to fetch /stats/parking, falling back to local charts:', err);
    }
  }

  // Fallback (mock or when stats endpoint unavailable): compute from current lots + mock busiest hours
  const labels = lots.map(l => l.name);
  const occ = lots.map(l => Math.round((l.capacity - l.available_spots) / Math.max(1, l.capacity) * 100));
  if (avgOccChart) avgOccChart.destroy();
  avgOccChart = new Chart(ctx1, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Occupancy % (from current results)', data: occ }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });

  const hours = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'];
  const counts = hours.map(() => Math.floor(Math.random() * 100));
  if (busyHoursChart) busyHoursChart.destroy();
  busyHoursChart = new Chart(ctx2, {
    type: 'line',
    data: { labels: hours, datasets: [{ label: 'Cars/hour (mock)', data: counts, tension: 0.35 }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}
// Map backend contract (available) → frontend shape (available_spots)
function mapBackendParking(p) {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    capacity: p.capacity,
    available_spots: (typeof p.available_spots === 'number') ? p.available_spots : (p.available ?? 0),
    price: p.price,
    updated_at: p.updated_at || new Date().toISOString()
  };
}

Object.assign(api, {
  async areasNear(lat, lng, radius = 1200, res = 9, limit = 20, sort = 'mix') {
    const url = `${API_BASE}/parking/areas?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}&res=${encodeURIComponent(res)}&limit=${encodeURIComponent(limit)}&sort=${encodeURIComponent(sort)}`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
            console.warn('areasNear failed:', r.status, r.statusText);
            return { items: [] };
        }
      let arr = [];
      try { arr = await r.json(); } catch (parseErr) { console.warn('areasNear JSON parse failed:', parseErr); }
      return { items: Array.isArray(arr) ? arr : [] };
    } catch (err) {
      console.warn('areasNear network error:', err);
      return { items: [] };
    }
  },
  async areaDetail(areaId, lat, lng, radius = 1200) {
    const url = `${API_BASE}/parking/areas/${encodeURIComponent(areaId)}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}`;
    const r = await fetch(url, { cache: 'no-store' });
    return r.json();
  },

    async geoSearch(q) {
        // 非空校验
        if (!q || (q = String(q).trim()).length < 2) return { items: [] };

        // mock 模式仍走 mock，方便离线演示
        if (USE_MOCK) return mock.geoSearch(q);

        try {
            // Greater Melbourne 的范围（lon,lat,lon,lat）
            const viewbox = '144.40,-37.30,145.70,-38.60';
            const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&dedupe=1&countrycodes=au&viewbox=${viewbox}&bounded=1&limit=8&q=${encodeURIComponent(q)}`;

            const r = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Accept-Language': 'en',
                    'User-Agent': 'FIT-5120-melb-parking/1.0 (contact: your-email@example.com)'
                }
            });
            if (!r.ok) throw new Error(`Nominatim ${r.status}`);

            const arr = await r.json();
            const items = (Array.isArray(arr) ? arr : []).map(a => ({
                place_id: a.place_id || `${a.lat},${a.lon}`,
                name: a.display_name,
                lat: Number(a.lat),
                lng: Number(a.lon)
            }));

            return { items };
        } catch (e) {
            console.warn('geoSearch fallback to mock due to error:', e);
            return mock.geoSearch(q);
        }
    },
  async parkingNear(lat, lng, radius) {
    // Real backend doesn't support lat/lng in this iteration; only use mock for this path
    if (USE_MOCK) return mock.parkingNear(lat, lng, radius);
    return { items: [] };
  },
  async parkingByDest(dest) {
    const r = await fetch(`${API_BASE}/parking?dest=${encodeURIComponent(dest)}`, { cache: 'no-store' });
    const arr = await r.json();              // backend returns an array
    return { items: arr.map(mapBackendParking) }; // normalize to frontend shape
  },
  __mockPushUpdates(ids) { return mock.pushUpdates(ids); }
});
// ===================== Melbourne Insights =====================
let avgOccChartRef, busiestHoursChartRef;

const mockInsights = {
    async averageOccupancy() {
        const lots = [
            { name: 'Flinders Lane Car Park', capacity: 220, available: 88 },
            { name: 'Russell St Car Park',    capacity: 160, available: 47 },
            { name: 'QV Car Park',            capacity: 120, available: 12 },
            { name: 'Derby Rd Car Park',      capacity: 180, available: 61 },
            { name: 'Caulfield Plaza Car Park', capacity: 140, available: 9 }
        ];
        const labels = lots.map(l => l.name);
        const values = lots.map(l => Math.round((1 - l.available / l.capacity) * 100));
        return { labels, values };
    },
    async busiestHoursToday() {
        const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);
        const counts = hours.map((_, i) => {
            const value = Math.round(80 - Math.pow(i - 13, 2) * 3);
            return Math.max(5, value);
        });
        return { hours, counts };
    }
};

if (!api.insights) api.insights = {};
api.insights.averageOccupancy = async function() {
    if (USE_MOCK) return mockInsights.averageOccupancy();
    try {
        const r = await fetch(`${API_BASE}/insights/average-occupancy`, { cache: 'no-store' });
        if (r.ok) return r.json();
    } catch(_) {}
    return mockInsights.averageOccupancy();
};
api.insights.busiestHoursToday = async function() {
    if (USE_MOCK) return mockInsights.busiestHoursToday();
    try {
        const r = await fetch(`${API_BASE}/insights/busiest-hours-today`, { cache: 'no-store' });
        if (r.ok) return r.json();
    } catch(_) {}
    return mockInsights.busiestHoursToday();
};

async function drawAverageOccupancy({ labels, values }) {
    const ctx = document.getElementById('avgOccupancyChart');
    if (!(ctx instanceof HTMLCanvasElement)) { console.warn('avgOccupancyChart canvas missing; skip.'); return; }
    if (avgOccChartRef) avgOccChartRef.destroy();
    avgOccChartRef = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Average occupancy (%)', data: values }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
    });
}

async function drawBusiestHours({ hours, counts }) {
    const ctx = document.getElementById('busiestHoursChart');
    if (!(ctx instanceof HTMLCanvasElement)) { console.warn('busiestHoursChart canvas missing; skip.'); return; }
    if (busiestHoursChartRef) busiestHoursChartRef.destroy();
    busiestHoursChartRef = new Chart(ctx, {
        type: 'line',
        data: { labels: hours, datasets: [{ label: 'Cars parked', data: counts, tension: 0.35 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: true, maxTicksLimit: 8 } } } }
    });
}

async function initInsights() {
    const avgCtx = document.getElementById('avgOccupancyChart');
    const busyCtx = document.getElementById('busiestHoursChart');
    if (!avgCtx || !busyCtx) return;

    const avgData = await api.insights.averageOccupancy();
    await drawAverageOccupancy(avgData);

    const busyData = await api.insights.busiestHoursToday();
    await drawBusiestHours(busyData);
}


const mock = (() => {
  const places = [
    { place_id:'g-fedsq', name:'Federation Square', lat:-37.817979, lng:144.969093 },
    { place_id:'g-caulfield', name:'Monash Caulfield Campus', lat:-37.8770, lng:145.0443 },
    { place_id:'g-swanston', name:'Swanston St & Bourke St', lat:-37.8134, lng:144.9635 },
  ];
  let lots = [
    { id:'CP-101', name:'Flinders Lane Car Park', lat:-37.8173, lng:144.9655, capacity:220, available_spots: 88, price:'$3/hr' },
    { id:'CP-102', name:'Russell St Car Park',    lat:-37.8128, lng:144.9675, capacity:160, available_spots: 47, price:'$4/hr' },
    { id:'CP-103', name:'QV Car Park',            lat:-37.8106, lng:144.9652, capacity:120, available_spots: 12, price:'$5/hr' },
    { id:'CP-201', name:'Derby Rd Car Park',      lat:-37.8779, lng:145.0449, capacity:180, available_spots: 61, price:'$3/hr' },
    { id:'CP-202', name:'Caulfield Plaza Car Park',lat:-37.8765,lng:145.0431, capacity:140, available_spots:  9, price:'$3/hr' },
  ].map(p => ({ ...p, updated_at: new Date().toISOString() }));
  function toRad(d){ return d*Math.PI/180; }
  function haversine(a,b){ const R=6371000, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng), la1=toRad(a.lat), la2=toRad(b.lat);
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
  return {
    async geoSearch(q){ const qn=q.toLowerCase(); const items=places.filter(p=>p.name.toLowerCase().includes(qn)).slice(0,8); return { items }; },
    async parkingNear(lat,lng,radius=900){ const c={lat,lng}; const items=lots.filter(p=>haversine(c,p)<=radius).map(p=>({...p}));
      if (!items.length){ const nearest=lots.map(p=>({...p,_d:haversine(c,p)})).sort((a,b)=>a._d-b._d).slice(0,3).map(({_d,...r})=>r); return { items: nearest }; }
      return { items }; },
    pushUpdates(ids){ const changes=[]; for (const id of ids){ const i=lots.findIndex(l=>l.id===id); if (i===-1) continue;
      const delta=Math.floor((Math.random()-0.5)*8); lots[i].available_spots=Math.max(0,Math.min(lots[i].capacity,lots[i].available_spots+delta));
      lots[i].updated_at=new Date().toISOString(); changes.push({ ...lots[i] }); } return changes; }
  };
})();

function distanceMeters(a,b){ const R=6371000, toRad=d=>d*Math.PI/180, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng), la1=toRad(a.lat), la2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

// ---- Auto-load initial car parks (no manual search needed) ----
let __initialLoaded = false;
async function loadInitialCarParks() {
  // Disabled: do not auto-load any parking on first open.
  // Keep UI clean until user performs a search.
  try {
    if (suggestionsEl) suggestionsEl.style.display = 'none';
    if (lotListEl) lotListEl.innerHTML = '';
    if (statusEl) statusEl.textContent = 'Search a place to see nearby car parks (500 m radius).';
    if (cluster) cluster.clearLayers();
    if (areasLayer) areasLayer.clearLayers();
    if (markers) markers.clear();
    window.__lastParkingItems = [];
    window.__lastAreas = [];
  } catch (_) {}
  return;
}
function updateDistancesFrom(origin){
    const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
    for (const p of list){
        p.distance_m = distanceMeters(origin, { lat: p.lat, lng: p.lng });
        const ref = areaDomRefs.get(p.id);
        if (ref){
            const distEl = ref.distEl;
            if (distEl) distEl.textContent = `${(p.distance_m/1000).toFixed(2)} km`;
        }
    }
    if (typeof statusEl !== 'undefined' && statusEl) {
        statusEl.textContent = `Distances updated from your location.`;
    }
}
// Run after DOM is ready
// ---- Auto-load initial car parks (no manual search needed) ----
// ---- Auto-load initial car parks (no manual search needed) ----
(function autoLoadBootstrap(){
    function boot(){
        // Do NOT auto-load any car parks on first open.
        // Only initialize the Insights charts; parking appears after a search.
        setTimeout(initInsights, 350);
        // Prepare a clean UI: no markers/cards until user searches
        try {
            if (suggestionsEl) suggestionsEl.style.display = 'none';
            if (lotListEl) lotListEl.innerHTML = '';
            if (statusEl) statusEl.textContent = 'Search a place to see nearby car parks (500 m radius).';
            if (cluster) cluster.clearLayers();
            if (areasLayer) areasLayer.clearLayers();
            if (markers) markers.clear();
            window.__lastParkingItems = [];
            window.__lastAreas = [];
        } catch (_) {}
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        boot();
    } else {
        document.addEventListener('DOMContentLoaded', boot);
    }
})();
// ---- /Auto-load initial car parks ----

// Click anywhere on the map to focus the nearest car park and show details
(function enableNearestOnMapClick(){
  let enabled = false;
  if (enabled) return;
  enabled = true;
  map.on('click', (e) => {
    const list = Array.isArray(window.__lastParkingItems) ? window.__lastParkingItems : [];
    if (!list.length) return;
    const target = { lat: e.latlng.lat, lng: e.latlng.lng };
    const nearest = list.reduce((best, cur) => {
      const d = distanceMeters(target, cur);
      return (!best || d < best.dist) ? { node: cur, dist: d } : best;
    }, null);
    if (nearest && nearest.node) {
      map.setView([nearest.node.lat, nearest.node.lng], 17);
      showLotPopup(nearest.node);
    }
  });
})();




// Jiazhen On Environment Impact
// === Environment Compare (free stack: Nominatim + OSRM) ===
(function EnvCompare(){
  const envIntro = document.getElementById('envIntro');
  const envGrid  = document.getElementById('envSuggestions');
  const btnLoc   = document.getElementById('useMyLocation');
  const btnGo    = document.getElementById('computeBtn');
  const destEl   = document.getElementById('destText');
  const originEl = document.getElementById('originStatus');
  const cbdOnlyEl= document.getElementById('cbdOnly');
  const envDistance = document.getElementById('envDistance');


  if (!btnLoc || !btnGo || !envIntro || !envGrid || !destEl) return;

  // State
  const F = { car:0.192, bus:0.105, tram:0.041, train:0.036, cycling:0, walking:0 }; // kg CO2/km
  const state = { origin: null, pickedDest: null };

  // Helpers
  const CBD = { lat: -37.8136, lon: 144.9631 }; // Melbourne CBD roughly at Swanston/Collins
  const MAX_SUG = 6;
  const km = n => Math.round(n*10)/10;
  const debounce = (fn, ms=250) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  const dist2CBD = (lat,lon) => {
    const dx = lat - CBD.lat, dy = lon - CBD.lon;
    return dx*dx + dy*dy; // enough for ranking
  };

  function normalizeQuery(q){
    let s = (q||'').trim();
    if (/^boxhill$/i.test(s)) s = 'Box Hill';
    if (!/\b(australia|victoria|melbourne)\b/i.test(s)) s += ', Victoria, Australia';
    return s;
  }

  // Geocode (with Melbourne/AU bias)
  async function geocodeNominatim(q){
    const base='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1';
    const q1 = normalizeQuery(q);
    const viewbox='144.40,-37.30,145.70,-38.60'; // lon,lat
    const tries = [
      `${base}&countrycodes=au&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(q1)}`,
      `${base}&countrycodes=au&q=${encodeURIComponent(q1)}`,
      `${base}&q=${encodeURIComponent(q1)}`
    ];
    for (const url of tries){
      const r = await fetch(url, { headers:{'Accept-Language':'en'} });
      if (!r.ok) continue;
      const arr = await r.json();
      if (arr && arr.length){
        const { lat, lon, display_name } = arr[0];
        return { lat: +lat, lon: +lon, name: display_name };
      }
    }
    throw new Error('No result for destination');
  }

  async function reverseGeocodeNominatim(lat, lon){
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const r = await fetch(url, { headers:{ 'Accept-Language':'en' } });
  if (!r.ok) throw new Error('Reverse geocoding failed');
  const j = await r.json();
  const a = j.address || {};
  // 取更“像地名”的优先级：大学/学院 > 医院/设施 > 郊区/街区 > 城市
  const main   = a.university || a.college || a.school || a.hospital || a.amenity || '';
  const area   = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || '';
  const post   = a.postcode || '';
  const label  = [main, area, post].filter(Boolean).join(', ')
               || (j.display_name ? j.display_name.split(',').slice(0,2).join(', ') : '');
  return label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }





  // OSRM road distance
  async function osrm(profile, a, b){
    const u = `https://router.project-osrm.org/route/v1/${profile}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&alternatives=false&steps=false`;
    const r = await fetch(u);
    if (!r.ok) throw new Error('OSRM routing failed');
    const j = await r.json();
    if (!j.routes || !j.routes.length) throw new Error('No route');
    const r0 = j.routes[0];
    return { km: r0.distance/1000 };
  }

  // Cards
  function renderCards(modes){
    const car = modes.find(m => m.id==='car');
    envGrid.innerHTML = modes.map(m=>{
      const savedPct = car && car.co2_kg>0 ? Math.round((1 - m.co2_kg/car.co2_kg)*100) : 0;
      const pct = Math.max(0, savedPct); // 防负数
      return `
        <article class="env-card">
          <header style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <h4 style="margin:0;font-size:16px">${m.label}</h4>
          </header>
          <div class="env-metric"><span>CO₂</span><strong>${m.co2_kg.toFixed(2)} kg</strong></div>
          <div class="env-metric"><span>Impact</span><strong>~${pct}% less CO₂ than car</strong></div>
        </article>`;
    }).join('');
  }


  // ---- Suggestions (simple UI + CBD-first / CBD-only) ----
  const sugList = document.createElement('ul');
  sugList.id = 'destSuggestions';
  sugList.className = 'suggestions';
  destEl.insertAdjacentElement('afterend', sugList);

  async function fetchSuggestions(q){
    const base='https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&dedupe=1';
    const viewbox='144.40,-37.30,145.70,-38.60'; // Greater Melbourne
    const q1 = normalizeQuery(q);
    const url = `${base}&countrycodes=au&viewbox=${viewbox}&bounded=1&limit=20&q=${encodeURIComponent(q1)}`;

    const r = await fetch(url, { headers:{ 'Accept-Language':'en' } });
    if (!r.ok) return [];
    const arr = await r.json();

    const cbdOnly = !!cbdOnlyEl?.checked;

    // Keep only roads (highway) and collapse duplicates by road + locality
    const groups = new Map();
    for (const a of arr){
      const addr = a.address || {};
      const isRoad = a.class === 'highway' || addr.road;
      if (!isRoad) continue;

      const road = (addr.road || (a.display_name?.split(',')[0]??'')).trim();
      if (!road) continue;

      const locality = addr.suburb || addr.neighbourhood || addr.city_district || addr.town || addr.city || '';
      const city = addr.city || addr.town || '';
      const postcode = addr.postcode || '';

      const lat = +a.lat, lon = +a.lon;
      const d2 = dist2CBD(lat, lon);
      const inCBD = (postcode==='3000') || (city==='Melbourne' && d2 < 0.00045); // ~2km window

      if (cbdOnly && !inCBD) continue;

      const context = [
        inCBD ? 'Melbourne CBD' : (locality || city || 'Melbourne'),
        inCBD ? '3000' : (postcode || '')
      ].filter(Boolean).join(', ');

      const key = road.toLowerCase() + '|' + (locality||city).toLowerCase();
      const cand = {
        label: road, context, lat, lon,
        priority: inCBD ? 0 : 1,
        d2
      };

      const prev = groups.get(key);
      if (!prev || cand.priority < prev.priority || (cand.priority===prev.priority && cand.d2 < prev.d2)){
        groups.set(key, cand);
      }
    }

    let items = Array.from(groups.values())
      .sort((a,b)=> a.priority - b.priority || a.d2 - b.d2 || a.label.localeCompare(b.label));

    // 如果开关太严格导致 0 条，自动回退到 CBD-first（不只限 CBD）
    if (!items.length && cbdOnly){
      if (cbdOnlyEl) cbdOnlyEl.checked = false;
      return fetchSuggestions(q);
    }

    return items.slice(0, MAX_SUG);
  }

  function renderSuggestions(items){
    if (!items.length){ sugList.classList.remove('show'); sugList.innerHTML=''; return; }
    sugList.innerHTML = items.map(it => `
      <li data-lat="${it.lat}" data-lon="${it.lon}" data-name="${(it.label + ', ' + it.context).replace(/"/g,'&quot;')}">
        <div style="font-weight:600">${it.label}</div>
        <div class="muted" style="font-size:12px">${it.context}</div>
      </li>
    `).join('');
    sugList.classList.add('show');
  }

  destEl.addEventListener('input', debounce(async ()=>{
    const q = destEl.value.trim();
    state.pickedDest = null;
    if (q.length < 3){ renderSuggestions([]); return; }
    const items = await fetchSuggestions(q);
    renderSuggestions(items);
  }, 250));

  sugList.addEventListener('click', (e)=>{
    const li = e.target.closest('li');
    if (!li) return;
    const lat = +li.dataset.lat, lon = +li.dataset.lon, name = li.dataset.name;
    state.pickedDest = { lat, lon, name };
    destEl.value = name;                 // ← 回填“路名 + 区域”
    destEl.focus();     
    destEl.setSelectionRange(destEl.value.length, destEl.value.length); // 光标到末尾
    renderSuggestions([]);
  });

  document.addEventListener('click', (e)=>{
    if (!sugList.contains(e.target) && e.target !== destEl) renderSuggestions([]);
  });

  // ---- Compute ----
  async function compute(){
  try{
    envIntro.textContent = 'Computing…';
    envGrid.innerHTML = '';
    if (envDistance) envDistance.style.display = 'none';   // 清空/隐藏距离条
    if (!state.origin) throw new Error('Please allow location first.');

    const q = (destEl.value||'').trim();
    if (!q && !state.pickedDest) throw new Error('Please enter a destination.');

    const dest = state.pickedDest || await geocodeNominatim(q);

    let carR, cycR, walkR;
    try{
      [carR, cycR, walkR] = await Promise.all([
        osrm('driving', state.origin, dest),
        osrm('cycling', state.origin, dest).catch(()=>null),
        osrm('foot', state.origin, dest).catch(()=>null)
      ]);
    }catch(_){}

    const carKm = carR?.km ?? 0;
    const cyclingKm = cycR?.km ?? carKm;
    const walkingKm = walkR?.km ?? carKm;

    // Try backend first
    let modes;
    try{
      const r = await fetch('/api/emissions', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          origin: state.origin, destination: dest,
          distance_km: carKm,
          distance_km_by_mode: { car:carKm, cycling:cyclingKm, walking:walkingKm }
        })
      });
      if (r.ok){
        const data = await r.json();
        const defaults = { car:carKm, cycling:cyclingKm, walking:walkingKm };
        modes = (data.modes||[]).map(m=>({
          ...m,
          distance_km: Number.isFinite(m.distance_km) ? m.distance_km : (defaults[m.id] ?? carKm)
        }));
      }
    }catch(_){}

    // Fallback factors
    if (!modes || !modes.length){
      const BASE = { car:carKm, bus:carKm, tram:carKm, train:carKm, cycling:cyclingKm, walking:walkingKm };
      modes = Object.entries(F).map(([id, f])=>({
        id, label: id[0].toUpperCase()+id.slice(1),
        distance_km: BASE[id],
        co2_kg: (BASE[id] ?? 0) * f
      })).filter(m => Number.isFinite(m.distance_km)).sort((a,b)=>a.co2_kg - b.co2_kg);
    }

    renderCards(modes);

    
    envIntro.textContent = `From your location to "${dest.name}"`;
    if (envDistance){
      envDistance.style.display = 'flex';
      envDistance.innerHTML = `<strong>Distance:</strong> <span>${km(carKm)} km</span> <span class="muted">via road network (OSRM)</span>`;
    }
  }catch(e){
    envIntro.textContent = e.message || 'Something went wrong.';
    envGrid.innerHTML = '';
    if (envDistance) envDistance.style.display = 'none';
  }
}

  // Location
  btnLoc.addEventListener('click', ()=>{
    if (!navigator.geolocation){
      originEl.textContent = 'Geolocation not supported in this browser.'; return;
    }
    originEl.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        state.origin = { lat, lon };

        
        let nice = '';
        try { nice = await reverseGeocodeNominatim(lat, lon); } catch(_) {}
        originEl.textContent = `Your Location: ${nice || `${lat.toFixed(5)}, ${lon.toFixed(5)}`}`;
        originEl.title = `${lat.toFixed(5)}, ${lon.toFixed(5)}`; // 悬停显示坐标
      },
      _  => originEl.textContent = 'Location permission denied or unavailable.',
      { enableHighAccuracy:true, timeout:10000, maximumAge:60000 }
    );
  });

  btnGo.addEventListener('click', compute);
})();
