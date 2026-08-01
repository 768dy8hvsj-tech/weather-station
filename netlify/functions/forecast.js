const USER_AGENT = "weather-consensus-app/1.0 (personal project; contact hakond@gmail.com)";

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const name = (params.name || "").trim();
  const stationId = params.station_id;

  if (!name) return json({ error: "Missing 'name' query parameter" }, 400);

  const geo = (await geocode(name, true)) || (await geocode(name, false));
  if (!geo) return json({ error: `Could not locate '${name}'` }, 404);

  let yrnoPoints;
  try {
    yrnoPoints = await fetchYrno(geo.lat, geo.lon);
  } catch (e) {
    return json({ error: `MET Norway fetch failed: ${e.message}` }, 502);
  }

  let vedurPoints = [];
  if (stationId) {
    try {
      vedurPoints = await fetchVedur(stationId);
    } catch (e) {
      vedurPoints = [];
    }
  }

  let openmeteoPoints = {};
  try {
    openmeteoPoints = await fetchOpenMeteo(geo.lat, geo.lon);
  } catch (e) {
    openmeteoPoints = {};
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
 * Returns {model_key: [{time, temp_c, wind_ms, precip_mm}, ...]} for each model in
 * OPEN_METEO_MODELS. One HTTP call regardless of how many models are requested.
 */
async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "temperature_2m,wind_speed_10m,precipitation",
    models: OPEN_METEO_MODELS.map(([modelId]) => modelId).join(","),
    timezone: "UTC",
    forecast_days: "4",
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
    const precs = hourly[`precipitation_${modelId}`];
    if (!temps) continue;
    out[key] = times.map((t, i) => {
      const windKmh = winds ? winds[i] : null;
      return {
        time: `${t}:00Z`,
        temp_c: temps[i] ?? null,
        wind_ms: windKmh !== null && windKmh !== undefined ? round1(windKmh / 3.6) : null,
        precip_mm: precs ? precs[i] ?? null : null,
      };
    });
  }
  return out;
}

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

    hours.push({
      time: yp.time,
      sources: {
        yrno: { temp_c: yp.temp_c, wind_ms: yp.wind_ms, precip_mm: yp.precip_mm, symbol: yp.symbol },
        vedur: vp
          ? { temp_c: vp.temp_c, wind_ms: vp.wind_ms, condition: vp.condition, direction: vp.direction }
          : null,
        openmeteo: omValues.length
          ? Object.fromEntries(
              Object.entries(om).map(([key, p]) => [key, { temp_c: p.temp_c, wind_ms: p.wind_ms }])
            )
          : null,
      },
      consensus: {
        temp_c: temps.length ? round1(avg(temps)) : null,
        temp_spread: temps.length > 1 ? round1(Math.max(...temps) - Math.min(...temps)) : 0,
        wind_ms: winds.length ? round1(avg(winds)) : null,
        source_count: temps.length,
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
