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
// Bumped on every loadForecast call so a slow reliability response for a place the
// user has since navigated away from can't clobber the panel for the current one.
let requestSeq = 0;

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
  const seq = ++requestSeq;
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
    loadReliability(data.location.lat, data.location.lon, seq);
  } catch (err) {
    statusEl.textContent = `Could not load forecast: ${err.message}`;
    statusEl.classList.add("error");
  }
}

/**
 * Fetched separately from the main forecast: Open-Meteo's Previous Runs API (which
 * this needs) alone takes ~3.3s, versus ~0.9s for everything else the main table
 * needs — blocking page render on it would erase most of the benefit of speeding up
 * the rest. Renders a lightweight loading state immediately so the panel doesn't pop
 * in from nothing once the slow request finally resolves.
 */
async function loadReliability(lat, lon, seq) {
  renderReliabilityLoading();
  try {
    const res = await fetch(`/api/reliability?lat=${lat}&lon=${lon}`);
    const data = await res.json();
    if (seq !== requestSeq) return; // user navigated to a different place meanwhile
    renderReliability(res.ok ? data.reliability : null);
  } catch (err) {
    if (seq === requestSeq) renderReliability(null);
  }
}

function renderReliabilityLoading() {
  reliabilityEl.innerHTML = `<p class="reliability-summary">Checking forecast reliability…</p>`;
  reliabilityEl.classList.remove("hidden");
}

let currentDaylight = [];
let currentGroundConditions = {};

function renderResult(data) {
  const { location, hours, daylight, ground_conditions } = data;
  currentDaylight = daylight || [];
  currentGroundConditions = ground_conditions || {};
  locationNameEl.textContent = location.name;
  locationMetaEl.textContent = location.resolved_name;
  const labels = location.source_labels || ["yr.no"];
  const noun = location.source_count === 1 ? "source" : "sources";
  sourceBadgeEl.textContent = `${location.source_count} ${noun}: ${labels.join(" + ")}`;

  reliabilityEl.classList.add("hidden");
  reliabilityEl.innerHTML = "";

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
    const titleText = document.createElement("span");
    titleText.textContent = formatDayTitle(dayKey);
    title.appendChild(titleText);

    const ground = currentGroundConditions[dayKey];
    if (ground) {
      const groundBadge = document.createElement("span");
      groundBadge.className = `ground-badge ground-${ground.tier}`;
      groundBadge.innerHTML = `${PUDDLE_ICON} ${ground.label}`;
      title.appendChild(groundBadge);
      attachHoverDetail(groundBadge, () => buildGroundHoverHtml(ground));
    }

    const bestWindow = findBestWindow(dayHours, currentDaylight);
    if (bestWindow) {
      const startHH = String(new Date(bestWindow.times[0]).getUTCHours()).padStart(2, "0");
      const endHH = String((new Date(bestWindow.times[bestWindow.times.length - 1]).getUTCHours() + 1) % 24).padStart(2, "0");
      const badge = document.createElement("span");
      badge.className = "best-window-badge";
      badge.innerHTML = `${GOLF_FLAG_ICON} Best window ${startHH}:00–${endHH}:00`;
      title.appendChild(badge);
    }
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
          <th>Golf</th>
          <th>yr.no</th>
          <th>vedur.is</th>
          <th>Open-Meteo</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    const bestTimes = new Set(bestWindow ? bestWindow.times : []);
    for (const h of dayHours) {
      const row = renderHourRow(h);
      if (bestTimes.has(h.time)) row.classList.add("best-window-row");
      tbody.appendChild(row);
    }
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    scroll.appendChild(table);
    card.appendChild(scroll);
    daysEl.appendChild(card);
  }

  resultEl.classList.remove("hidden");
}

/**
 * Best contiguous 4-hour window in a day, by total golf score, but only returned if
 * at least one hour in the window reaches Fair or better (score >=45) — a window of
 * uniformly poor hours shouldn't get highlighted just for being the "least bad".
 */
function findBestWindow(dayHours, daylight) {
  const WINDOW_SIZE = 4;
  const MIN_QUALIFYING_SCORE = 45;
  if (dayHours.length < WINDOW_SIZE) return null;

  let best = null;
  for (let i = 0; i <= dayHours.length - WINDOW_SIZE; i++) {
    const window = dayHours.slice(i, i + WINDOW_SIZE);

    // Past ~48h, vedur.is/yr.no's data resolution drops from hourly to 6-hourly, so
    // 4 consecutive array entries stop meaning "4 consecutive hours" — skip any window
    // whose span isn't actually (WINDOW_SIZE - 1) hours, real time, start to end.
    const spanMs = Date.parse(window[window.length - 1].time) - Date.parse(window[0].time);
    if (spanMs !== (WINDOW_SIZE - 1) * 3600 * 1000) continue;

    const scores = window.map((h) => golfScore(h.consensus, h.time, daylight));
    if (scores.some((s) => s === null)) continue;
    if (!scores.some((s) => s.score >= MIN_QUALIFYING_SCORE)) continue;
    const total = scores.reduce((sum, s) => sum + s.score, 0);
    if (!best || total > best.total) {
      best = { total, times: window.map((h) => h.time) };
    }
  }
  return best;
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
  const dirDeg = h.consensus.wind_dir_deg;
  const dirCompass = h.consensus.wind_dir_compass;
  const golf = golfScore(h.consensus, h.time, currentDaylight);

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
      <div class="wind-cell">
        ${
          dirDeg !== null && dirDeg !== undefined
            ? `<span class="wind-arrow" style="transform:rotate(${(dirDeg + 180) % 360}deg)" title="Wind from ${dirCompass} (${dirDeg}°)">${WIND_ARROW}</span>`
            : ""
        }
        <span>${fmtWind(h.consensus.wind_ms)}${dirCompass ? ` ${dirCompass}` : ""}</span>
      </div>
      ${wind ? `<div class="wind-bar-track" title="${wind.tierLabel} wind"><div class="wind-bar-fill wind-${wind.tier}" style="width:${wind.pct}%"></div></div>` : ""}
    </td>
    <td class="${precip.cls}">
      ${precipIcon ? `<span class="precip-icon icon-${precipIcon}">${WEATHER_ICONS[precipIcon]}</span>` : ""}${precip.text}
    </td>
    <td>${
      golf
        ? `<div class="golf-cell"><span class="golf-badge grade-${golf.tier}">${golf.label}</span>${golfFactorIcons(golf)}</div>`
        : `<span class="no-source">—</span>`
    }</td>
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

  if (golf) {
    const golfBadgeEl = tr.querySelector(".golf-badge");
    if (golfBadgeEl) attachHoverDetail(golfBadgeEl, () => buildGolfHoverHtml(golf));
  }

  return tr;
}

/**
 * Full breakdown for the Golf badge's hover panel — the same score/notes/factors data
 * that used to be squeezed into a single `title=` string, now as a readable list, one
 * sentence per factor that actually moved the score.
 */
/**
 * Day-by-day weighted rainfall breakdown for the Course Conditions badge — makes the
 * "why is a sunny day marked Soft" case (the whole reason this badge exists) legible:
 * each contributing day, how much fell, and how much that day still counts for today.
 */
function buildGroundHoverHtml(ground) {
  const rows = ground.breakdown
    .map((b) => {
      const dayLabel = b.days_ago === 1 ? "Yesterday" : `${b.days_ago} days ago`;
      const detail =
        b.mm === null ? "no data" : `${b.mm}mm × ${b.weight.toFixed(2)} weight = ${b.contribution}mm`;
      return `<li>${dayLabel}: ${detail}</li>`;
    })
    .join("");
  return `
    <div class="hover-title">${ground.label} — ${ground.api_mm}mm weighted 3-day total</div>
    <p class="hover-desc">${ground.description}</p>
    <ul class="hover-list">${rows}</ul>
  `;
}

function buildGolfHoverHtml(golf) {
  // The "Dark" case (outside daylight hours) short-circuits before factors are computed
  // at all, so it only ever has `notes` — fall back to those, then to the "no source"
  // deductions message rather than misreporting an unscored hour as ideal.
  let rows;
  if (golf.factors && golf.factors.length) {
    rows = golf.factors.map((f) => `<li>${f.title}</li>`).join("");
  } else if (golf.notes && golf.notes.length) {
    rows = golf.notes.map((n) => `<li>${n}</li>`).join("");
  } else {
    rows = `<li class="muted">No deductions — conditions are within the ideal range.</li>`;
  }
  return `
    <div class="hover-title">${golf.label} · ${golf.score}/100</div>
    <ul class="hover-list">${rows}</ul>
  `;
}

/**
 * WMO Beaufort wind force scale (0-12), official m/s bands and names — replaces an
 * earlier invented 3-tier bucket. `tier` (good/warn/bad) is just for the bar color;
 * `force`/`name` are the real classification, shown in the tooltip.
 */
const BEAUFORT_SCALE = [
  { max: 0.5, force: 0, name: "Calm" },
  { max: 1.5, force: 1, name: "Light air" },
  { max: 3.3, force: 2, name: "Light breeze" },
  { max: 5.4, force: 3, name: "Gentle breeze" },
  { max: 7.9, force: 4, name: "Moderate breeze" },
  { max: 10.7, force: 5, name: "Fresh breeze" },
  { max: 13.8, force: 6, name: "Strong breeze" },
  { max: 17.1, force: 7, name: "Near gale" },
  { max: 20.7, force: 8, name: "Gale" },
  { max: 24.4, force: 9, name: "Strong gale" },
  { max: 28.4, force: 10, name: "Storm" },
  { max: 32.6, force: 11, name: "Violent storm" },
  { max: Infinity, force: 12, name: "Hurricane force" },
];

function beaufortForce(ms) {
  if (ms === null || ms === undefined) return null;
  return BEAUFORT_SCALE.find((b) => ms <= b.max);
}

function windSeverity(ms) {
  const b = beaufortForce(ms);
  if (!b) return null;
  const pct = Math.max(4, Math.round((b.force / 12) * 100));
  const tier = b.force <= 3 ? "good" : b.force <= 6 ? "warn" : "bad";
  return { pct, tier, tierLabel: `Force ${b.force} – ${b.name}` };
}

function precipIconCategory(precip) {
  if (!precip || precip.type === "none") return null;
  if (precip.type === "snow") return "snow";
  return precip.mm !== null && precip.mm !== undefined && precip.mm < 0.5 ? "drizzle" : "rain";
}

/**
 * NWS Wind Chill Temperature Index (metric form): 13.12 + 0.6215T - 11.37*V^0.16 +
 * 0.3965*T*V^0.16, T in °C, V in km/h. Only valid/meaningful for T<=10°C and wind
 * >=4.8km/h (~1.33 m/s) per NWS — outside that domain wind has negligible extra
 * cooling effect on the body, so this just returns the actual temp unchanged rather
 * than extrapolating a formula outside where it's been validated.
 */
function windChillC(tempC, windMs) {
  if (tempC === null || tempC === undefined || windMs === null || windMs === undefined) return tempC;
  const windKmh = windMs * 3.6;
  if (tempC > 10 || windKmh < 4.8) return tempC;
  const v16 = Math.pow(windKmh, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v16 + 0.3965 * tempC * v16;
}

/** Strictly between sunrise and sunset for the matching day; null if no daylight data. */
function isDaylight(timeIso, daylight) {
  if (!daylight || !daylight.length) return null;
  const dateKey = timeIso.slice(0, 10);
  const day = daylight.find((d) => d.date === dateKey);
  if (!day) return null;
  const t = Date.parse(timeIso);
  return t >= Date.parse(day.sunrise) && t <= Date.parse(day.sunset);
}

/**
 * Points-off-100 heuristic for "is this good golf weather" — not a recognized
 * industry model (there isn't one), but built on real reference points instead of
 * invented ones: WMO Beaufort force for wind, NWS wind chill for "feels like" temp,
 * and actual daylight hours (not weather, but you can't play in the dark).
 */
function golfScore(consensus, timeIso, daylight) {
  const daylightNow = isDaylight(timeIso, daylight);
  if (daylightNow === false) {
    return { score: 0, label: "Dark", tier: "dark", notes: ["outside daylight hours"] };
  }

  const temp = consensus.temp_c;
  const wind = consensus.wind_ms;
  const precip = consensus.precip || {};
  if (temp === null || temp === undefined || wind === null || wind === undefined) return null;

  let score = 100;
  const notes = [];
  const factors = [];

  if (precip.type === "rain" || precip.type === "snow") {
    const mm = precip.mm || 0;
    let severity;
    if (mm < 1) {
      score -= 15;
      notes.push("light precip");
      severity = 1;
    } else if (mm < 3) {
      score -= 30;
      notes.push("moderate precip");
      severity = 2;
    } else {
      score -= 50;
      notes.push("heavy precip");
      severity = 3;
    }
    factors.push({ type: "precip", kind: precip.type, severity, title: notes[notes.length - 1] });
  }

  const b = beaufortForce(wind);
  const windDeductions = [0, 0, 0, 5, 10, 20, 35, 50, 70, 90, 90, 90, 90];
  if (b && windDeductions[b.force] > 0) {
    score -= windDeductions[b.force];
    const note = `force ${b.force} wind (${b.name.toLowerCase()})`;
    notes.push(note);
    const severity = b.force <= 4 ? 1 : b.force <= 6 ? 2 : 3;
    factors.push({ type: "wind", severity, dirDeg: consensus.wind_dir_deg, title: note });
  }

  // Sized so each band caps the best-case label even with perfect wind/precip:
  // 4-8°C alone (-40) tops out at 60 (Fair, never Good); below 4°C alone (-60)
  // tops out at 40 (Poor, never Fair/Good).
  const feelsLike = windChillC(temp, wind);
  if (feelsLike >= 12 && feelsLike <= 22) {
    // ideal range, no deduction
  } else {
    const kind = feelsLike < 12 ? "cold" : "hot";
    let severity;
    if ((feelsLike >= 8 && feelsLike < 12) || (feelsLike > 22 && feelsLike <= 26)) {
      score -= 10;
      notes.push("cool/warm feels-like");
      severity = 1;
    } else if ((feelsLike >= 4 && feelsLike < 8) || (feelsLike > 26 && feelsLike <= 30)) {
      score -= 40;
      notes.push("cold/hot feels-like");
      severity = 2;
    } else {
      score -= 60;
      notes.push("extreme feels-like temp");
      severity = 3;
    }
    factors.push({ type: "temp", kind, severity, title: `${notes[notes.length - 1]} (${feelsLike.toFixed(1)}°C)` });
  }

  score = Math.max(0, Math.min(100, score));

  // "Excellent" is a specific set of conditions, not just a high score: dry and not
  // heavily overcast (clear/partly-cloudy/cloudy all count — cloud cover on its own
  // isn't unpleasant for golf, only heavy overcast or precip is), wind <=2 m/s,
  // feels-like >16°C. A high score reached some other way is capped at Good instead.
  const sky = skyCategory({ cloudCoverPct: consensus.cloud_cover_pct, precipType: precip.type });
  const meetsExcellent = ["clear", "partly-cloudy", "cloudy"].includes(sky) && wind <= 2 && feelsLike > 16;
  if (score >= 85 && !meetsExcellent) {
    score = 84;
    notes.push("capped: Excellent needs dry, not-overcast sky, wind ≤2m/s, feels-like >16°C");
  }

  let label, tier;
  if (score >= 85) {
    label = "Excellent";
    tier = "good";
  } else if (score >= 65) {
    label = "Good";
    tier = "good";
  } else if (score >= 45) {
    label = "Fair";
    tier = "warn";
  } else if (score >= 25) {
    label = "Poor";
    tier = "bad";
  } else {
    label = "Unplayable";
    tier = "bad";
  }

  return { score, label, tier, notes, factors };
}

/**
 * Renders each scoring factor as 1-3 repeated small icons (escalating with severity)
 * instead of a single number — wind arrows rotated to actual direction, raindrops/
 * snowflakes for precip, thermometers for cold/hot. No icons at all means nothing
 * dragged the score down.
 */
function golfFactorIcons(golf) {
  if (!golf || !golf.factors || !golf.factors.length) return "";
  return golf.factors
    .map((f) => {
      if (f.type === "wind") {
        const rotation = ((f.dirDeg ?? 0) + 180) % 360;
        const sevClass = f.severity <= 1 ? "sev-1" : f.severity <= 2 ? "sev-2" : "sev-3";
        const icon = Array.from(
          { length: f.severity },
          () => `<span class="factor-icon wind-factor" style="transform:rotate(${rotation}deg)">${WIND_ARROW}</span>`
        ).join("");
        return `<span class="factor-group ${sevClass}" title="${f.title}">${icon}</span>`;
      }
      if (f.type === "precip") {
        const sevClass = f.severity <= 1 ? "sev-1" : f.severity <= 2 ? "sev-2" : "sev-3";
        const iconSvg = f.kind === "snow" ? SNOWFLAKE_ICON : RAINDROP_ICON;
        const colorClass = f.kind === "snow" ? "precip-factor-snow" : "precip-factor-rain";
        const icon = Array.from(
          { length: f.severity },
          () => `<span class="factor-icon ${colorClass}">${iconSvg}</span>`
        ).join("");
        return `<span class="factor-group ${sevClass}" title="${f.title}">${icon}</span>`;
      }
      if (f.type === "temp") {
        const sevClass = f.severity <= 1 ? "sev-1" : f.severity <= 2 ? "sev-2" : "sev-3";
        const colorClass = f.kind === "cold" ? "temp-factor-cold" : "temp-factor-hot";
        const icon = Array.from(
          { length: f.severity },
          () => `<span class="factor-icon ${colorClass}">${THERMOMETER_ICON}</span>`
        ).join("");
        return `<span class="factor-group ${sevClass}" title="${f.title}">${icon}</span>`;
      }
      return "";
    })
    .join("");
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

/**
 * Generic hover/focus detail panel — replaces plain `title=` tooltips (OS-styled, no
 * markup, easy to miss) with a small floating panel we control. One panel element is
 * reused/repositioned rather than created per-badge; `buildHtml` is called lazily on
 * show so callers can pass a closure instead of computing content up front for every
 * badge whether or not it's ever hovered.
 */
let hoverPanelEl = null;
let hoverHideTimer = null;

function attachHoverDetail(el, buildHtml) {
  el.classList.add("has-hover-detail");
  if (el.tabIndex < 0) el.tabIndex = 0;
  const show = () => {
    clearTimeout(hoverHideTimer);
    showHoverPanel(el, buildHtml());
  };
  const hide = () => {
    // Small delay so moving the mouse from the badge into the panel itself (e.g. to
    // read a longer breakdown) doesn't immediately dismiss it.
    hoverHideTimer = setTimeout(hideHoverPanel, 120);
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
}

function showHoverPanel(anchor, html) {
  if (!hoverPanelEl) {
    hoverPanelEl = document.createElement("div");
    hoverPanelEl.className = "hover-panel";
    hoverPanelEl.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverPanelEl.addEventListener("mouseleave", () => {
      hoverHideTimer = setTimeout(hideHoverPanel, 120);
    });
    document.body.appendChild(hoverPanelEl);
  }
  hoverPanelEl.innerHTML = html;
  hoverPanelEl.classList.add("visible");
  positionHoverPanel(anchor, hoverPanelEl);
}

function hideHoverPanel() {
  if (hoverPanelEl) hoverPanelEl.classList.remove("visible");
}

function positionHoverPanel(anchor, panel) {
  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const margin = 8;

  let left = rect.left + window.scrollX;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - panelRect.width - margin;
  left = Math.min(Math.max(left, window.scrollX + margin), Math.max(maxLeft, window.scrollX + margin));

  let top = rect.bottom + window.scrollY + margin;
  if (rect.bottom + panelRect.height + margin > window.innerHeight) {
    top = rect.top + window.scrollY - panelRect.height - margin;
  }

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

window.addEventListener("scroll", hideHoverPanel, true);
window.addEventListener("resize", hideHoverPanel);
