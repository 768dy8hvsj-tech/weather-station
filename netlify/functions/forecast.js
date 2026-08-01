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

  const hours = buildConsensus(yrnoPoints, vedurPoints);

  return json({
    location: {
      name,
      lat: geo.lat,
      lon: geo.lon,
      resolved_name: geo.display_name,
      vedur_station_id: stationId ? Number(stationId) : null,
      source_count: vedurPoints.length ? 2 : 1,
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

function buildConsensus(yrnoPoints, vedurPoints) {
  const hours = [];
  const now = Date.now();
  const horizon = now + 72 * 3600 * 1000;

  for (const yp of yrnoPoints) {
    const t = Date.parse(yp.time);
    if (t < now - 3600 * 1000 || t > horizon) continue;

    const vp = vedurPoints.length ? nearest(vedurPoints, t) : null;
    const temps = [yp.temp_c, vp?.temp_c].filter((v) => v !== null && v !== undefined);
    const winds = [yp.wind_ms, vp?.wind_ms].filter((v) => v !== null && v !== undefined);

    hours.push({
      time: yp.time,
      sources: {
        yrno: { temp_c: yp.temp_c, wind_ms: yp.wind_ms, precip_mm: yp.precip_mm, symbol: yp.symbol },
        vedur: vp
          ? { temp_c: vp.temp_c, wind_ms: vp.wind_ms, condition: vp.condition, direction: vp.direction }
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
