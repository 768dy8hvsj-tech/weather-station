const input = document.getElementById("search-input");
const suggestionsEl = document.getElementById("suggestions");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const locationNameEl = document.getElementById("location-name");
const locationMetaEl = document.getElementById("location-meta");
const sourceBadgeEl = document.getElementById("source-badge");
const reliabilityEl = document.getElementById("reliability");
const daysEl = document.getElementById("days");

let debounceTimer = null;
let activeIndex = -1;
let currentSuggestions = [];

const initialParams = new URLSearchParams(window.location.search);
const initialPlace = initialParams.get("place");
if (initialPlace) {
  input.value = initialPlace;
  loadForecast(initialPlace, initialParams.get("station_id"));
}

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const q = input.value.trim();
  if (!q) {
    hideSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => runSearch(q), 200);
});

input.addEventListener("keydown", (e) => {
  if (!currentSuggestions.length) {
    if (e.key === "Enter") loadForecast(input.value.trim(), null);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive(Math.min(activeIndex + 1, currentSuggestions.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive(Math.max(activeIndex - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    const pick = activeIndex >= 0 ? currentSuggestions[activeIndex] : currentSuggestions[0];
    selectSuggestion(pick);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!suggestionsEl.contains(e.target) && e.target !== input) hideSuggestions();
});

async function runSearch(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  currentSuggestions = [
    ...data.matches.map((m) => ({ type: "station", ...m })),
    { type: "freeform", name: q },
  ];
  renderSuggestions(q);
}

function renderSuggestions(q) {
  activeIndex = -1;
  suggestionsEl.innerHTML = "";
  currentSuggestions.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "suggestion-item" + (s.type === "freeform" ? " freeform" : "");
    if (s.type === "station") {
      div.innerHTML = `<span>${s.name}</span><span class="region">${s.region}</span>`;
    } else {
      div.innerHTML = `<span>Search &ldquo;${q}&rdquo;</span><span class="region">no vedur.is match</span>`;
    }
    div.addEventListener("click", () => selectSuggestion(s));
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.remove("hidden");
}

function setActive(idx) {
  activeIndex = idx;
  [...suggestionsEl.children].forEach((el, i) => el.classList.toggle("active", i === idx));
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  currentSuggestions = [];
}

function selectSuggestion(s) {
  input.value = s.name;
  hideSuggestions();
  loadForecast(s.name, s.type === "station" ? s.id : null);
}

async function loadForecast(name, stationId) {
  if (!name) return;
  resultEl.classList.add("hidden");
  statusEl.classList.remove("hidden", "error");
  statusEl.textContent = `Fetching forecasts for "${name}"…`;

  const params = new URLSearchParams({ name });
  if (stationId) params.set("station_id", stationId);

  try {
    const res = await fetch(`/api/forecast?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    renderResult(data);
    statusEl.classList.add("hidden");
  } catch (err) {
    statusEl.textContent = `Could not load forecast: ${err.message}`;
    statusEl.classList.add("error");
  }
}

function renderResult(data) {
  const { location, hours, reliability } = data;
  locationNameEl.textContent = location.name;
  locationMetaEl.textContent = location.resolved_name;
  const labels = location.source_labels || ["yr.no"];
  const noun = location.source_count === 1 ? "source" : "sources";
  sourceBadgeEl.textContent = `${location.source_count} ${noun}: ${labels.join(" + ")}`;

  renderReliability(reliability);

  const byDay = new Map();
  for (const h of hours) {
    const dayKey = h.time.slice(0, 10);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(h);
  }

  daysEl.innerHTML = "";
  for (const [dayKey, dayHours] of byDay) {
    const card = document.createElement("div");
    card.className = "day-card";

    const title = document.createElement("div");
    title.className = "day-title";
    title.textContent = formatDayTitle(dayKey);
    card.appendChild(title);

    const table = document.createElement("table");
    table.className = "hours";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th>
          <th>Consensus</th>
          <th>Wind</th>
          <th>Precip</th>
          <th>yr.no</th>
          <th>vedur.is</th>
          <th>Open-Meteo</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    for (const h of dayHours) {
      tbody.appendChild(renderHourRow(h));
    }
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    scroll.appendChild(table);
    card.appendChild(scroll);
    daysEl.appendChild(card);
  }

  resultEl.classList.remove("hidden");
}

const OPENMETEO_LABELS = { ecmwf: "ECMWF", gfs: "GFS", icon: "ICON" };

function renderReliability(reliability) {
  if (!reliability) {
    reliabilityEl.classList.add("hidden");
    reliabilityEl.innerHTML = "";
    return;
  }

  const { avg_mae_temp_c, models, window_hours } = reliability;
  const grade = avg_mae_temp_c <= 0.75 ? "good" : avg_mae_temp_c <= 1.5 ? "warn" : "bad";
  const gradeLabel = grade === "good" ? "Good" : grade === "warn" ? "Fair" : "Poor";

  const modelBits = Object.entries(models)
    .map(([key, m]) => `${OPENMETEO_LABELS[key] || key} ±${m.mae_temp_c}°`)
    .join(" · ");

  reliabilityEl.innerHTML = `
    <div class="reliability-header">
      <span class="reliability-title">Forecast reliability (last ${window_hours}h)</span>
      <span class="reliability-grade grade-${grade}">${gradeLabel}</span>
    </div>
    <p class="reliability-summary">
      Open-Meteo's models have averaged <strong>±${avg_mae_temp_c}°C</strong> off their own
      24h-ahead predictions over the last ${window_hours}h: ${modelBits}.
    </p>
  `;
  reliabilityEl.classList.remove("hidden");
}

function renderHourRow(h) {
  const tr = document.createElement("tr");
  const time = new Date(h.time);
  const hh = String(time.getUTCHours()).padStart(2, "0");

  const spreadClass =
    h.consensus.temp_spread <= 1.5 ? "spread-good" : h.consensus.temp_spread <= 3 ? "spread-warn" : "spread-bad";

  const yrno = h.sources.yrno;
  const vedur = h.sources.vedur;
  const openmeteo = h.sources.openmeteo;
  const precip = fmtPrecip(h.consensus.precip);
  const sky = skyCategory({ cloudCoverPct: h.consensus.cloud_cover_pct, precipType: h.consensus.precip.type });
  const wind = windSeverity(h.consensus.wind_ms);
  const precipIcon = precipIconCategory(h.consensus.precip);

  tr.innerHTML = `
    <td>${hh}:00</td>
    <td>
      <div class="consensus-cell">
        <div class="consensus-icon icon-${sky}" title="${sky.replace("-", " ")}">${WEATHER_ICONS[sky] || WEATHER_ICONS.unknown}</div>
        <span class="consensus-temp">${fmtTemp(h.consensus.temp_c)}</span>
        ${h.consensus.source_count > 1 ? `<span class="spread-dot ${spreadClass}" title="${h.consensus.temp_spread}°C spread across ${h.consensus.source_count} sources"></span>` : ""}
      </div>
    </td>
    <td>
      ${fmtWind(h.consensus.wind_ms)}
      ${wind ? `<div class="wind-bar-track" title="${wind.tierLabel} wind"><div class="wind-bar-fill wind-${wind.tier}" style="width:${wind.pct}%"></div></div>` : ""}
    </td>
    <td class="${precip.cls}">
      ${precipIcon ? `<span class="precip-icon icon-${precipIcon}">${WEATHER_ICONS[precipIcon]}</span>` : ""}${precip.text}
    </td>
    <td class="source-cell">${
      yrno
        ? `<span class="val">${fmtTemp(yrno.temp_c)}</span> · ${fmtWind(yrno.wind_ms)}${
            yrno.precip_mm ? ` · ${yrno.precip_mm}mm` : ""
          }`
        : `<span class="no-source">—</span>`
    }</td>
    <td class="source-cell">${
      vedur
        ? `<span class="val">${fmtTemp(vedur.temp_c)}</span> · ${fmtWind(vedur.wind_ms)} ${vedur.direction || ""}`
        : `<span class="no-source">—</span>`
    }</td>
    <td class="source-cell openmeteo-cell">${
      openmeteo
        ? Object.entries(openmeteo)
            .map(([key, v]) => {
              const extra = v.snow_cm > 0 ? ` · ${v.snow_cm}cm snow` : v.precip_mm > 0 ? ` · ${v.precip_mm}mm` : "";
              return `<div>${OPENMETEO_LABELS[key] || key} <span class="val">${fmtTemp(v.temp_c)}</span>${extra}</div>`;
            })
            .join("")
        : `<span class="no-source">—</span>`
    }</td>
  `;
  return tr;
}

/**
 * Simplified 3-tier Beaufort-ish scale: <=7 m/s roughly Beaufort 0-4 (light-moderate
 * breeze), <=14 m/s Beaufort 5-7 (fresh-strong breeze/near gale), above that gale+.
 * Bar fill is scaled against 25 m/s as a visual "full" reference, not a hard cap.
 */
function windSeverity(ms) {
  if (ms === null || ms === undefined) return null;
  const pct = Math.max(4, Math.min(100, Math.round((ms / 25) * 100)));
  const tier = ms <= 7 ? "good" : ms <= 14 ? "warn" : "bad";
  const tierLabel = ms <= 7 ? "Light-moderate" : ms <= 14 ? "Fresh-strong" : "Gale+";
  return { pct, tier, tierLabel };
}

function precipIconCategory(precip) {
  if (!precip || precip.type === "none") return null;
  if (precip.type === "snow") return "snow";
  return precip.mm !== null && precip.mm !== undefined && precip.mm < 0.5 ? "drizzle" : "rain";
}

function fmtPrecip(precip) {
  if (!precip || precip.type === "none") return { text: "—", cls: "precip-none" };
  if (precip.type === "snow") {
    const amount =
      precip.snow_cm !== null && precip.snow_cm !== undefined ? `${precip.snow_cm}cm` : `${precip.mm}mm`;
    return { text: `${amount} snow`, cls: "precip-snow" };
  }
  return { text: `${precip.mm}mm rain`, cls: "precip-rain" };
}

function fmtTemp(t) {
  return t === null || t === undefined ? "—" : `${Math.round(t * 10) / 10}°`;
}

function fmtWind(w) {
  return w === null || w === undefined ? "—" : `${Math.round(w * 10) / 10} m/s`;
}

function formatDayTitle(dayKey) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
