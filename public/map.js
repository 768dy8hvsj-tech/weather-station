// Shared Leaflet map used on the home page (all of Iceland) and region drill-down pages
// (zoomed to that region's stations). Loaded dynamically so pages that don't use it
// (forecast.html) never pull in Leaflet at all.
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const ESRI_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ICELAND_BOUNDS = [
  [63.2, -24.6],
  [66.6, -13.3],
];

const MARKER_COLORS = {
  clear: "#f59e0b",
  "partly-cloudy": "#f59e0b",
  cloudy: "#8a93a3",
  overcast: "#8a93a3",
  fog: "#8a93a3",
  unknown: "#8a93a3",
  drizzle: "#2563eb",
  rain: "#2563eb",
  sleet: "#0ea5e9",
  snow: "#0ea5e9",
  thunder: "#d97706",
};

let leafletLoadPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

async function initStationMap(containerId) {
  await loadLeaflet();
  const el = document.getElementById(containerId);
  if (!el) return null;

  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer(ESRI_IMAGERY_URL, {
    attribution: "Tiles &copy; Esri",
    maxZoom: 12,
  }).addTo(map);

  // Leaflet reads the container's size synchronously on creation, which can be stale
  // (or 0×0) if the browser hasn't committed layout yet — a single invalidateSize()
  // call right away isn't reliably enough, so wait two animation frames (past the next
  // paint) before the first fitBounds, which otherwise can silently compute zoom 0 (the
  // whole world in one tile) against the wrong size.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  map.invalidateSize();
  map.fitBounds(ICELAND_BOUNDS);

  const markersLayer = L.layerGroup().addTo(map);
  return { map, markersLayer };
}

/**
 * Swaps the marker layer for a fresh set of stations without recreating the map, so a
 * 10-minute refresh or a golf-filter toggle doesn't reset the user's pan/zoom.
 * `fitBounds: true` is only passed on the map's first population (region drill-down) —
 * later updates deliberately leave the view alone.
 */
function updateStationMarkers(handle, stations, { fitBounds = false } = {}) {
  if (!handle) return;
  const { map, markersLayer } = handle;
  markersLayer.clearLayers();

  const withCoords = stations.filter((s) => s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined);
  for (const s of withCoords) {
    const category = conditionCategory(s.condition);
    const color = MARKER_COLORS[category] || MARKER_COLORS.unknown;
    const icon = L.divIcon({
      className: "station-marker",
      html: `<div class="station-marker-dot" style="--marker-color:${color}">${WEATHER_ICONS[category] || WEATHER_ICONS.unknown}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const marker = L.marker([s.lat, s.lon], { icon, title: s.name }).addTo(markersLayer);
    const temp = s.temp_c === null || s.temp_c === undefined ? "—" : `${Math.round(s.temp_c)}°`;
    marker.bindTooltip(`<strong>${s.name}</strong><br>${temp} · ${s.condition || "—"}`, {
      direction: "top",
      offset: [0, -12],
    });
    marker.on("click", () => {
      window.location.href = `/forecast.html?place=${encodeURIComponent(s.name)}&station_id=${s.id}`;
    });
  }

  if (fitBounds && withCoords.length) {
    map.invalidateSize();
    map.fitBounds(
      L.latLngBounds(withCoords.map((s) => [s.lat, s.lon])),
      { padding: [28, 28], maxZoom: 9 }
    );
  }
}
