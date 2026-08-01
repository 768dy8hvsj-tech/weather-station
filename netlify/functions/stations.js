const overview = require("../../station-overview.json");

const USER_AGENT = "weather-consensus-app/1.0 (personal project; contact hakond@gmail.com)";

/**
 * Next-hour snapshot for every station in station-overview.json.
 *
 * vedur.is's forecast API takes one station id per request (no batching — comma or
 * repeated "ids" params silently only honor the first one), so covering a page full
 * of stations means one request per station. Fetched concurrently via Promise.all
 * since they're independent, I/O-bound calls.
 */
exports.handler = async () => {
  const target = Date.now() + 3600 * 1000;
  const results = await Promise.all(overview.map((station) => fetchOne(station, target)));
  return json({ stations: results });
};

async function fetchOne(station, targetMs) {
  try {
    const points = await fetchVedur(station.id);
    const hit = nearest(points, targetMs, 90);
    return {
      id: station.id,
      name: station.name,
      region: station.region,
      time: hit?.time ?? null,
      temp_c: hit?.temp_c ?? null,
      wind_ms: hit?.wind_ms ?? null,
      direction: hit?.direction ?? null,
      condition: hit?.condition ?? null,
    };
  } catch (e) {
    return { id: station.id, name: station.name, region: station.region, time: null, temp_c: null, wind_ms: null, direction: null, condition: null };
  }
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

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
