const USER_AGENT = "weather-consensus-app/1.0 (personal project; contact hakond@gmail.com)";

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
const COMPASS_TO_DEGREES = Object.fromEntries(COMPASS_POINTS.map((name, i) => [name, i * 22.5]));

function degreesToCompass(deg) {
  if (deg === null || deg === undefined) return null;
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

/**
 * Plain averaging breaks across the 0/360 wrap (350° and 10° should average to 0°,
 * not 180°), so this averages the unit vectors instead and converts back.
 */
function circularMeanDegrees(degreesList) {
  if (!degreesList.length) return null;
  const x = degreesList.reduce((sum, d) => sum + Math.cos((d * Math.PI) / 180), 0);
  const y = degreesList.reduce((sum, d) => sum + Math.sin((d * Math.PI) / 180), 0);
  if (x === 0 && y === 0) return null;
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const name = (params.name || "").trim();
  const stationId = params.station_id;

  if (!name) return json({ error: "Missing 'name' query parameter" }, 400);

  // geocode and vedur.is don't depend on each other (vedur.is is keyed by station id,
  // not lat/lon) — start vedur.is immediately instead of waiting on geocoding first,
  // then fetch yr.no/Open-Meteo together once geocoding resolves. Reliability is
  // deliberately NOT fetched here: it alone takes ~3.3s (Open-Meteo's Previous Runs
  // API is just slow), versus ~0.9s for everything else combined — blocking the whole
  // page on it would erase most of the win from parallelizing. The frontend fetches
  // /api/reliability separately after the main table renders.
  const vedurPromise = stationId ? fetchVedur(stationId).catch(() => []) : Promise.resolve([]);

  const geo = (await geocode(name, true)) || (await geocode(name, false));
  if (!geo) return json({ error: `Could not locate '${name}'` }, 404);

  let yrnoPoints;
  let openmeteoPoints = {};
  let daylight = [];
  let vedurPoints = [];
  try {
    const [yrnoResult, openmeteoResult, vedurResult] = await Promise.all([
      fetchYrno(geo.lat, geo.lon),
      fetchOpenMeteo(geo.lat, geo.lon).catch(() => ({ models: {}, daylight: [] })),
      vedurPromise,
    ]);
    yrnoPoints = yrnoResult;
    openmeteoPoints = openmeteoResult.models;
    daylight = openmeteoResult.daylight;
    vedurPoints = vedurResult;
  } catch (e) {
    return json({ error: `MET Norway fetch failed: ${e.message}` }, 502);
  }

  let groundConditions = {};
  try {
    groundConditions = computeGroundConditions(openmeteoPoints);
  } catch (e) {
    groundConditions = {};
  }

  const hours = buildConsensus(yrnoPoints, vedurPoints, openmeteoPoints);

  const sourceLabels = ["yr.no"];
  if (vedurPoints.length) sourceLabels.push("vedur.is");
  const openmeteoKeys = Object.keys(openmeteoPoints);
  if (openmeteoKeys.length) {
    sourceLabels.push(`Open-Meteo (${openmeteoKeys.map((k) => k.toUpperCase()).join("/")})`);
  }

  return json({
    location: {
      name,
      lat: geo.lat,
      lon: geo.lon,
      resolved_name: geo.display_name,
      vedur_station_id: stationId ? Number(stationId) : null,
      source_count: 1 + (vedurPoints.length ? 1 : 0) + openmeteoKeys.length,
      source_labels: sourceLabels,
    },
    hours,
    daylight,
    ground_conditions: groundConditions,
  });
};

/**
 * Small Icelandic place names are often shared by an obscure natural feature
 * (a random peak, a stream) and the actual settlement/landmark people mean.
 * Nominatim's importance ranking doesn't reliably prefer the latter, so we
 * pull a few candidates and skip bare "natural" features when a better
 * option exists.
 */
async function geocode(query, icelandOnly) {
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "5" });
  if (icelandOnly) params.set("countrycodes", "is");
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  const nonNatural = data.filter((hit) => hit.category !== "natural");
  const hit = nonNatural[0] || data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), display_name: hit.display_name };
}

async function fetchYrno(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  return raw.properties.timeseries.map((entry) => {
    const instant = entry.data.instant.details;
    const next1h = entry.data.next_1_hours || {};
    return {
      time: entry.time,
      temp_c: instant.air_temperature ?? null,
      wind_ms: instant.wind_speed ?? null,
      wind_dir_deg: instant.wind_from_direction ?? null,
      precip_mm: next1h.details?.precipitation_amount ?? null,
      symbol: next1h.summary?.symbol_code ?? null,
    };
  });
}

async function fetchVedur(stationId) {
  const url = `https://xmlweather.vedur.is/?op_w=xml&type=forec&lang=en&view=xml&ids=${encodeURIComponent(stationId)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  const stationMatch = xml.match(/<station[^>]*>([\s\S]*?)<\/station>/);
  if (!stationMatch) return [];

  const points = [];
  const forecastRe = /<forecast>([\s\S]*?)<\/forecast>/g;
  let m;
  while ((m = forecastRe.exec(stationMatch[1]))) {
    const block = m[1];
    const ftime = tag(block, "ftime");
    if (!ftime) continue;
    const wind = tag(block, "F");
    const temp = tag(block, "T");
    points.push({
      time: ftime.replace(" ", "T") + "Z",
      temp_c: temp ? parseFloat(temp) : null,
      wind_ms: wind ? parseFloat(wind) : null,
      direction: tag(block, "D"),
      condition: tag(block, "W"),
    });
  }
  return points;
}

const OPEN_METEO_MODELS = [
  ["ecmwf_ifs025", "ecmwf"],
  ["gfs_seamless", "gfs"],
  ["icon_seamless", "icon"],
];

/**
 * Returns {models: {model_key: [{time, temp_c, wind_ms, precip_mm, snow_cm}, ...]},
 * daylight: [{date, sunrise, sunset}, ...]}. One HTTP call covers both the per-model
 * hourly forecast and daily sunrise/sunset (the same request just gets a "daily" block
 * added alongside "hourly" — no separate call needed).
 *
 * "precipitation" is liquid-equivalent (mm, rain+snow combined); "snowfall" is snow
 * accumulation specifically (cm) — together they let us tell rain from snow, which
 * vedur.is's forecast API doesn't expose as a number at all (only a text description).
 */
async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,snowfall,cloud_cover",
    daily: "sunrise,sunset",
    models: OPEN_METEO_MODELS.map(([modelId]) => modelId).join(","),
    timezone: "UTC",
    forecast_days: "4",
    // Extra trailing days aren't shown in the hourly table (buildConsensus still filters
    // to now-1h.. onward for that), but they're what computeGroundConditions uses to know
    // what actually fell before "now" — see GROUND_LOOKBACK_DAYS.
    past_days: String(GROUND_LOOKBACK_DAYS),
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const hourly = raw.hourly || {};
  const times = hourly.time || [];

  const out = {};
  for (const [modelId, key] of OPEN_METEO_MODELS) {
    const temps = hourly[`temperature_2m_${modelId}`];
    const winds = hourly[`wind_speed_10m_${modelId}`];
    const windDirs = hourly[`wind_direction_10m_${modelId}`];
    const precs = hourly[`precipitation_${modelId}`];
    const snows = hourly[`snowfall_${modelId}`];
    const clouds = hourly[`cloud_cover_${modelId}`];
    if (!temps) continue;
    out[key] = times.map((t, i) => {
      const windKmh = winds ? winds[i] : null;
      return {
        time: `${t}:00Z`,
        temp_c: temps[i] ?? null,
        wind_ms: windKmh !== null && windKmh !== undefined ? round1(windKmh / 3.6) : null,
        wind_dir_deg: windDirs ? windDirs[i] ?? null : null,
        precip_mm: precs ? precs[i] ?? null : null,
        snow_cm: snows ? snows[i] ?? null : null,
        cloud_cover_pct: clouds ? clouds[i] ?? null : null,
      };
    });
  }

  // With models= set, Open-Meteo suffixes daily fields per model too (sunrise_ecmwf_ifs025,
  // etc.) even though sunrise/sunset are astronomical, not model-dependent — identical
  // across all of them, so just take whichever model's columns are present.
  const daily = raw.daily || {};
  const sunriseKey = Object.keys(daily).find((k) => k.startsWith("sunrise"));
  const sunsetKey = Object.keys(daily).find((k) => k.startsWith("sunset"));
  const daylight =
    sunriseKey && sunsetKey
      ? (daily.time || []).map((d, i) => ({
          date: d,
          sunrise: `${daily[sunriseKey][i]}:00Z`,
          sunset: `${daily[sunsetKey][i]}:00Z`,
        }))
      : [];

  return { models: out, daylight };
}

const GROUND_LOOKBACK_DAYS = 3;
// Antecedent Precipitation Index style decay: yesterday counts fully, the day before at
// 60%, three days back at 36% — a rough stand-in for how fast a well-drained course
// actually dries out, not a measured drainage rate for any specific course.
const GROUND_DECAY = 0.6;

// [upper bound in mm of weighted accumulation, tier key, label, description] — thresholds
// are a judgment call, not a published turf-management standard; there isn't one that maps
// cleanly onto "will this course be muddy today."
const GROUND_TIERS = [
  [5, "firm", "Firm", "Dry underfoot — little to no rain in the trailing 3 days."],
  [15, "normal", "Normal", "Some recent rain, but not enough to noticeably soften the course."],
  [30, "soft", "Soft", "Meaningful accumulation — expect mud on fairways and possible casual water in low spots."],
  [
    Infinity,
    "saturated",
    "Saturated",
    "Heavy accumulation — standing water is likely; the course may go cart-path-only or delay/close.",
  ],
];

function classifyGround(apiMm) {
  for (const [threshold, tier, label, desc] of GROUND_TIERS) {
    if (apiMm < threshold) return { tier, label, desc };
  }
  const last = GROUND_TIERS[GROUND_TIERS.length - 1];
  return { tier: last[1], label: last[2], desc: last[3] }; // unreachable (last threshold is Infinity)
}

/**
 * For each calendar day covered by openmeteoPoints (which spans now-GROUND_LOOKBACK_DAYS
 * through now+forecast_days thanks to the past_days param), compute a decay-weighted
 * rainfall index from the 3 days immediately before it and classify how that likely
 * leaves the course playing.
 *
 * For a day still ahead of "now", the trailing days may themselves be forecast rain
 * rather than observed rain — that's intentional: checking ground conditions for a round
 * two days out should already account for rain expected to fall between now and then, not
 * just what's happened so far.
 *
 * Precip here is liquid-equivalent mm (rain+snow combined, same field already used for the
 * hourly table) — a heavy snow day registers the same as an equivalent rain day, which
 * overstates softening in a hard freeze and understates it once snow melts. No attempt is
 * made to model that; it's a known simplification.
 */
function computeGroundConditions(openmeteoPoints) {
  const perModelDaily = {};
  for (const [key, points] of Object.entries(openmeteoPoints)) {
    const daily = {};
    for (const p of points) {
      const dateStr = p.time.slice(0, 10);
      const mm = p.precip_mm || 0;
      daily[dateStr] = (daily[dateStr] || 0) + mm;
    }
    perModelDaily[key] = daily;
  }

  const allDatesSet = new Set();
  for (const daily of Object.values(perModelDaily)) {
    for (const d of Object.keys(daily)) allDatesSet.add(d);
  }
  const allDates = [...allDatesSet].sort();

  const dailyMm = {};
  for (const d of allDates) {
    const vals = Object.values(perModelDaily)
      .filter((daily) => d in daily)
      .map((daily) => daily[d]);
    if (vals.length) dailyMm[d] = round1(avg(vals));
  }

  const result = {};
  for (const d of allDates) {
    const target = new Date(`${d}T00:00:00Z`);
    const breakdown = [];
    let apiMm = 0;
    let haveData = false;
    for (let daysAgo = 1; daysAgo <= GROUND_LOOKBACK_DAYS; daysAgo++) {
      const dayDate = new Date(target.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);
      const mm = dailyMm[dayDate] ?? null;
      const weight = round2(Math.pow(GROUND_DECAY, daysAgo - 1));
      const contribution = mm !== null ? round1(mm * weight) : 0;
      if (mm !== null) {
        haveData = true;
        apiMm += contribution;
      }
      breakdown.push({ date: dayDate, days_ago: daysAgo, mm, weight, contribution });
    }
    if (!haveData) continue;
    apiMm = round1(apiMm);
    const { tier, label, desc } = classifyGround(apiMm);
    result[d] = { api_mm: apiMm, tier, label, description: desc, breakdown };
  }
  return result;
}

const round2 = (n) => Math.round(n * 100) / 100;

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function nearest(points, targetMs, maxDeltaMinutes = 40) {
  let best = null;
  let bestDelta = Infinity;
  for (const p of points) {
    const delta = Math.abs(Date.parse(p.time) - targetMs);
    if (delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  return bestDelta <= maxDeltaMinutes * 60 * 1000 ? best : null;
}

const SNOW_HINTS = ["snow", "sleet"];

/**
 * vedur.is only gives a text condition, no numeric precip — so "type" leans on
 * Open-Meteo's snowfall (when available) and falls back to symbol/condition text
 * hints. This is a simple heuristic, not a real precip-type model.
 */
function resolvePrecip(yrnoSymbol, vedurCondition, precipMmValues, snowCmValues) {
  const mm = precipMmValues.length ? round1(avg(precipMmValues)) : null;
  const snowCm = snowCmValues.length ? round1(avg(snowCmValues)) : null;

  const textSaysSnow = [yrnoSymbol, vedurCondition].some(
    (s) => s && SNOW_HINTS.some((h) => s.toLowerCase().includes(h))
  );

  let type;
  if ((snowCm !== null && snowCm > 0.05) || (snowCm === null && textSaysSnow)) {
    type = "snow";
  } else if (mm !== null && mm > 0.05) {
    type = "rain";
  } else {
    type = "none";
  }

  return { mm, snow_cm: snowCm, type, source_count: precipMmValues.length };
}

function buildConsensus(yrnoPoints, vedurPoints, openmeteoPoints) {
  const hours = [];
  const now = Date.now();
  const horizon = now + 72 * 3600 * 1000;
  const openmeteoEntries = Object.entries(openmeteoPoints);

  for (const yp of yrnoPoints) {
    const t = Date.parse(yp.time);
    if (t < now - 3600 * 1000 || t > horizon) continue;

    const vp = vedurPoints.length ? nearest(vedurPoints, t) : null;
    const om = {};
    for (const [key, points] of openmeteoEntries) {
      const p = nearest(points, t);
      if (p) om[key] = p;
    }
    const omValues = Object.values(om);

    const temps = [yp.temp_c, vp?.temp_c, ...omValues.map((p) => p.temp_c)].filter(
      (v) => v !== null && v !== undefined
    );
    const winds = [yp.wind_ms, vp?.wind_ms, ...omValues.map((p) => p.wind_ms)].filter(
      (v) => v !== null && v !== undefined
    );
    const precipMmValues = [yp.precip_mm, ...omValues.map((p) => p.precip_mm)].filter(
      (v) => v !== null && v !== undefined
    );
    const snowCmValues = omValues.map((p) => p.snow_cm).filter((v) => v !== null && v !== undefined);
    const precip = resolvePrecip(yp.symbol, vp?.condition, precipMmValues, snowCmValues);

    const cloudValues = omValues.map((p) => p.cloud_cover_pct).filter((v) => v !== null && v !== undefined);
    const cloudCoverPct = cloudValues.length ? Math.round(avg(cloudValues)) : null;

    const windDirValues = [yp.wind_dir_deg, vp ? COMPASS_TO_DEGREES[vp.direction] : undefined, ...omValues.map((p) => p.wind_dir_deg)].filter(
      (v) => v !== null && v !== undefined
    );
    const windDirDeg = circularMeanDegrees(windDirValues);

    hours.push({
      time: yp.time,
      sources: {
        yrno: { temp_c: yp.temp_c, wind_ms: yp.wind_ms, wind_dir_deg: yp.wind_dir_deg, precip_mm: yp.precip_mm, symbol: yp.symbol },
        vedur: vp
          ? { temp_c: vp.temp_c, wind_ms: vp.wind_ms, condition: vp.condition, direction: vp.direction }
          : null,
        openmeteo: omValues.length
          ? Object.fromEntries(
              Object.entries(om).map(([key, p]) => [
                key,
                { temp_c: p.temp_c, wind_ms: p.wind_ms, wind_dir_deg: p.wind_dir_deg, precip_mm: p.precip_mm, snow_cm: p.snow_cm },
              ])
            )
          : null,
      },
      consensus: {
        temp_c: temps.length ? round1(avg(temps)) : null,
        temp_spread: temps.length > 1 ? round1(Math.max(...temps) - Math.min(...temps)) : 0,
        wind_ms: winds.length ? round1(avg(winds)) : null,
        wind_dir_deg: windDirDeg !== null ? Math.round(windDirDeg) : null,
        wind_dir_compass: degreesToCompass(windDirDeg),
        source_count: temps.length,
        precip,
        cloud_cover_pct: cloudCoverPct,
      },
    });
  }
  return hours;
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const round1 = (n) => Math.round(n * 10) / 10;

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
