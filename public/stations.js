const gridEl = document.getElementById("station-grid");
const statusEl = document.getElementById("status");
const updatedEl = document.getElementById("updated-at");
const sliderEl = document.getElementById("hours-slider");
const sliderValueEl = document.getElementById("slider-value");
const pageTitleEl = document.getElementById("page-title");
const pageSubtitleEl = document.getElementById("page-subtitle");
const backLinkEl = document.getElementById("back-link");
const golfFilterWrapEl = document.getElementById("golf-filter-wrap");
const golfFilterToggleEl = document.getElementById("golf-filter-toggle");

const REFRESH_MS = 10 * 60 * 1000;

// Same page/script serves both the home overview (all curated stations, grouped by
// region) and a region drill-down (every vedur.is station in one region, flat) —
// distinguished only by this query param, so region links are just "?region=X".
const initialUrlParams = new URLSearchParams(window.location.search);
const regionFilter = initialUrlParams.get("region");

if (regionFilter) {
  document.title = `${regionFilter} — Weather Consensus`;
  pageTitleEl.textContent = regionFilter;
  pageSubtitleEl.textContent = `All ${regionFilter} stations, from the Icelandic Met Office's own network.`;
  backLinkEl.classList.remove("hidden");
}

// Region links carry the home page's current slider position (?hours=N) so drilling
// into a region doesn't reset back to "Now".
const initialHours = Number(initialUrlParams.get("hours"));
if (Number.isFinite(initialHours) && initialHours >= 0 && initialHours <= 72) {
  sliderEl.value = initialHours;
}

let hoursAhead = Number(sliderEl.value);
let fetchDebounce = null;

// Region-only filter for stations near a real golf course (see golf-stations.js). Kept
// client-side over the already-fetched station list — toggling it never needs a refetch.
let golfOnly = initialUrlParams.get("golf") === "1";
let lastStations = [];

// Map is created once and reused across refreshes/toggles so pan/zoom survives them —
// only the region view's first population fits the view to that region's stations.
let mapReadyPromise = null;
let mapFitted = false;
function ensureMap() {
  if (!mapReadyPromise) mapReadyPromise = initStationMap("station-map");
  return mapReadyPromise;
}

golfFilterToggleEl.addEventListener("click", () => {
  golfOnly = !golfOnly;
  const url = new URL(window.location.href);
  if (golfOnly) url.searchParams.set("golf", "1");
  else url.searchParams.delete("golf");
  history.replaceState(null, "", url);
  render(lastStations);
});

updateSliderLabel();
loadStations();
setInterval(loadStations, REFRESH_MS);

sliderEl.addEventListener("input", () => {
  hoursAhead = Number(sliderEl.value);
  updateSliderLabel();
  clearTimeout(fetchDebounce);
  fetchDebounce = setTimeout(loadStations, 200);
});

function updateSliderLabel() {
  if (hoursAhead === 0) {
    sliderValueEl.textContent = "Now";
    return;
  }
  const target = new Date(Date.now() + hoursAhead * 3600 * 1000);
  const label = target.toLocaleString("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  sliderValueEl.textContent = `+${hoursAhead}h (${label} UTC)`;
}

async function loadStations() {
  try {
    const params = new URLSearchParams({ hours: hoursAhead });
    if (regionFilter) params.set("region", regionFilter);
    const res = await fetch(`/api/stations?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    render(data.stations);
    statusEl.classList.add("hidden");
  } catch (err) {
    statusEl.textContent = `Could not load stations: ${err.message}`;
    statusEl.classList.remove("hidden");
    statusEl.classList.add("error");
  }
}

function render(stations) {
  lastStations = stations;
  gridEl.innerHTML = "";

  if (regionFilter) {
    const golfStations = stations.filter((s) => GOLF_STATION_IDS.has(s.id));
    updateGolfFilterUI(golfStations.length);

    const mapStations = golfOnly ? golfStations : stations;
    ensureMap().then((handle) => {
      updateStationMarkers(handle, mapStations, { fitBounds: !mapFitted });
      mapFitted = true;
    });

    // Already scoped to one region (the page heading says which) — a flat grid, no
    // redundant region sub-headers.
    const grid = document.createElement("div");
    grid.className = "station-cards";
    for (const s of mapStations) grid.appendChild(renderCard(s));
    gridEl.appendChild(grid);
  } else {
    ensureMap().then((handle) => updateStationMarkers(handle, stations));

    const byRegion = new Map();
    for (const s of stations) {
      if (!byRegion.has(s.region)) byRegion.set(s.region, []);
      byRegion.get(s.region).push(s);
    }

    for (const [region, list] of byRegion) {
      const section = document.createElement("section");
      section.className = "region-section";

      const title = document.createElement("h2");
      title.className = "region-title";
      const link = document.createElement("a");
      link.href = `/?region=${encodeURIComponent(region)}&hours=${hoursAhead}`;
      link.textContent = region;
      title.appendChild(link);
      section.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "station-cards";
      for (const s of list) grid.appendChild(renderCard(s));
      section.appendChild(grid);
      gridEl.appendChild(section);
    }
  }

  const now = new Date();
  updatedEl.textContent = `Updated ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

function updateGolfFilterUI(golfCount) {
  if (golfCount === 0) {
    golfFilterWrapEl.classList.add("hidden");
    return;
  }
  golfFilterWrapEl.classList.remove("hidden");
  golfFilterToggleEl.setAttribute("aria-pressed", String(golfOnly));
  golfFilterToggleEl.classList.toggle("active", golfOnly);
  golfFilterToggleEl.innerHTML = `${GOLF_FLAG_ICON} <span>Golf Courses (${golfCount})</span>`;
}

function renderCard(s) {
  const a = document.createElement("a");
  a.className = "station-card";
  a.href = `/forecast.html?place=${encodeURIComponent(s.name)}&station_id=${s.id}`;

  const category = conditionCategory(s.condition);
  const hh = s.time ? String(new Date(s.time).getUTCHours()).padStart(2, "0") + ":00" : "—";
  const golfCourses = GOLF_STATION_COURSES[s.id];

  a.innerHTML = `
    <div class="station-icon icon-${category}">${WEATHER_ICONS[category] || WEATHER_ICONS.unknown}</div>
    <div class="station-info">
      <div class="station-name">${s.name}</div>
      <div class="station-condition">${s.condition || "—"} · ${hh}</div>
      ${
        golfCourses
          ? `<div class="station-golf" title="${golfCourses.join("; ").replace(/"/g, "&quot;")}">${GOLF_FLAG_ICON}<span>${golfCourses
              .map((c) => c.replace(/\s*\([^)]*\)$/, ""))
              .join(", ")}</span></div>`
          : ""
      }
    </div>
    <div class="station-readout">
      <div class="station-temp">${fmtTemp(s.temp_c)}</div>
      <div class="station-wind">${fmtWind(s.wind_ms)} ${s.direction || ""}</div>
    </div>
  `;
  return a;
}

function fmtTemp(t) {
  return t === null || t === undefined ? "—" : `${Math.round(t)}°`;
}

function fmtWind(w) {
  return w === null || w === undefined ? "—" : `${Math.round(w)} m/s`;
}

// Icon set and conditionCategory() now live in icons.js, loaded before this script.
