const input = document.getElementById("search-input");
const suggestionsEl = document.getElementById("suggestions");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const locationNameEl = document.getElementById("location-name");
const locationMetaEl = document.getElementById("location-meta");
const sourceBadgeEl = document.getElementById("source-badge");
const daysEl = document.getElementById("days");

let debounceTimer = null;
let activeIndex = -1;
let currentSuggestions = [];

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
  const { location, hours } = data;
  locationNameEl.textContent = location.name;
  locationMetaEl.textContent = location.resolved_name;
  sourceBadgeEl.textContent =
    location.source_count === 2 ? "2 sources: yr.no + vedur.is" : "1 source: yr.no only";

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
          <th>yr.no</th>
          <th>vedur.is</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    for (const h of dayHours) {
      tbody.appendChild(renderHourRow(h));
    }
    card.appendChild(table);
    daysEl.appendChild(card);
  }

  resultEl.classList.remove("hidden");
}

function renderHourRow(h) {
  const tr = document.createElement("tr");
  const time = new Date(h.time);
  const hh = String(time.getUTCHours()).padStart(2, "0");

  const spreadClass =
    h.consensus.temp_spread <= 1 ? "spread-good" : h.consensus.temp_spread <= 2.5 ? "spread-warn" : "spread-bad";

  const yrno = h.sources.yrno;
  const vedur = h.sources.vedur;

  tr.innerHTML = `
    <td>${hh}:00</td>
    <td>
      <span class="consensus-temp">${fmtTemp(h.consensus.temp_c)}</span>
      ${h.consensus.source_count > 1 ? `<span class="spread-dot ${spreadClass}" title="${h.consensus.temp_spread}°C spread between sources"></span>` : ""}
    </td>
    <td>${fmtWind(h.consensus.wind_ms)}</td>
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
  `;
  return tr;
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
