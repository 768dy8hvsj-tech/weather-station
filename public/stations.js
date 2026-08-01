const gridEl = document.getElementById("station-grid");
const statusEl = document.getElementById("status");
const updatedEl = document.getElementById("updated-at");
const sliderEl = document.getElementById("hours-slider");
const sliderValueEl = document.getElementById("slider-value");

const REFRESH_MS = 10 * 60 * 1000;

let hoursAhead = Number(sliderEl.value);
let fetchDebounce = null;

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
    const res = await fetch(`/api/stations?hours=${hoursAhead}`);
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
  const byRegion = new Map();
  for (const s of stations) {
    if (!byRegion.has(s.region)) byRegion.set(s.region, []);
    byRegion.get(s.region).push(s);
  }

  gridEl.innerHTML = "";
  for (const [region, list] of byRegion) {
    const section = document.createElement("section");
    section.className = "region-section";

    const title = document.createElement("h2");
    title.className = "region-title";
    title.textContent = region;
    section.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "station-cards";
    for (const s of list) {
      grid.appendChild(renderCard(s));
    }
    section.appendChild(grid);
    gridEl.appendChild(section);
  }

  const now = new Date();
  updatedEl.textContent = `Updated ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

function renderCard(s) {
  const a = document.createElement("a");
  a.className = "station-card";
  a.href = `/forecast.html?place=${encodeURIComponent(s.name)}&station_id=${s.id}`;

  const category = conditionCategory(s.condition);
  const hh = s.time ? String(new Date(s.time).getUTCHours()).padStart(2, "0") + ":00" : "—";

  a.innerHTML = `
    <div class="station-icon icon-${category}">${WEATHER_ICONS[category] || WEATHER_ICONS.unknown}</div>
    <div class="station-info">
      <div class="station-name">${s.name}</div>
      <div class="station-condition">${s.condition || "—"} · ${hh}</div>
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
