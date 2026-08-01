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

function conditionCategory(condition) {
  if (!condition) return "unknown";
  const c = condition.toLowerCase();
  if (c.includes("thunder")) return "thunder";
  if (c.includes("sleet")) return "sleet";
  if (c.includes("snow")) return "snow";
  if (c.includes("drizzle")) return "drizzle";
  if (c.includes("rain") || c.includes("shower")) return "rain";
  if (c.includes("fog") || c.includes("mist")) return "fog";
  if (c.includes("overcast")) return "overcast";
  if (c.includes("partly") && c.includes("cloud")) return "partly-cloudy";
  if (c.includes("cloud")) return "cloudy";
  if (c.includes("clear")) return "clear";
  return "unknown";
}

const CLOUD_PATH =
  "M7 18a3.8 3.8 0 0 1-.4-7.58 5.3 5.3 0 0 1 10.3 1.4 3.3 3.3 0 0 1-.4 6.58c-.1 0-.2 0-.3-.02L7 18Z";

const SUN_RAYS =
  '<path d="M12 2.5v2.3M12 19.2v2.3M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.4 19.6l1.6-1.6M18 6l1.6-1.6"/>';

function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const WEATHER_ICONS = {
  clear: svg(`<circle cx="12" cy="12" r="4.3"/>${SUN_RAYS}`),
  "partly-cloudy": svg(
    `<circle cx="9" cy="8.5" r="3.2"/><path d="M9 4.2V3M12.7 6l.9-.9M4.8 6l-.9-.9" />` +
      `<path d="M9.5 20a3.6 3.6 0 0 1-.4-7.18 5 5 0 0 1 9.7 1.32 3.1 3.1 0 0 1-.4 6.2c-.1 0-.2 0-.3-.02L9.5 20Z" transform="translate(1,0)"/>`
  ),
  cloudy: svg(`<path d="${CLOUD_PATH}"/>`),
  overcast: svg(`<path d="${CLOUD_PATH}" fill="currentColor" fill-opacity="0.3"/>`),
  fog: svg(
    `<path d="M4 9.5h13.5M4 13h16M4 16.5h11" stroke-width="1.6"/>`
  ),
  drizzle: svg(`<path d="${CLOUD_PATH}"/><path d="M9 19v1.6M13 19v1.6M17 18.4v1.6" stroke-width="1.4"/>`),
  rain: svg(`<path d="${CLOUD_PATH}"/><path d="M8.5 19.5 7.5 22M13 19.5 12 22M17.5 18.8l-1 2.2" stroke-width="1.7"/>`),
  sleet: svg(
    `<path d="${CLOUD_PATH}"/><path d="M8.5 19.5 7.5 22M17.5 18.8l-1 2.2" stroke-width="1.7"/><path d="M12.5 19.2v1.2M11.9 19.8h1.2M12.05 19.05l1.1 1.1M13.15 19.05l-1.1 1.1" stroke-width="1.3"/>`
  ),
  snow: svg(
    `<path d="${CLOUD_PATH}"/>` +
      `<g stroke-width="1.3"><path d="M8.5 18.6v3.2M7.1 20.2h2.8M7.5 19l2 2M9.5 19l-2 2"/>` +
      `<path d="M16 18.6v3.2M14.6 20.2h2.8M15 19l2 2M17 19l-2 2"/></g>`
  ),
  thunder: svg(`<path d="${CLOUD_PATH}"/><path d="M12.5 14.5 10 19h3l-1.5 4.5 4-6h-3l1.5-3Z" fill="currentColor" stroke="none"/>`),
  unknown: svg(
    `<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.8 2.8"/>` +
      `<path d="M9.6 9.8a2.5 2.5 0 1 1 3.5 2.3c-.7.35-1.1.9-1.1 1.7" stroke-width="1.6"/>` +
      `<path d="M12 16.3v.01" stroke-width="2.2"/>`
  ),
};
