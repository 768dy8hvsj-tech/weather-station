const overview = require("../../station-overview.json");
const allStations = require("../../vedur-stations.json");

const USER_AGENT = "weather-consensus-app/1.0 (personal project; contact hakond@gmail.com)";

/**
 * Snapshot for every station in station-overview.json (or every station in one region,
 * from vedur-stations.json, for the region drill-down page) at now + hoursAhead.
 *
 * vedur.is's forecast API takes one station id per request (no batching — comma or
 * repeated "ids" params silently only honor the first one), so covering a page full
 * of stations means one request per station. Fetched concurrently via Promise.all
 * since they're independent, I/O-bound calls. The largest single region (Faxaflói,
 * 42 stations) is still comfortably covered this way.
 *
 * vedur.is's forecast resolution is hourly for roughly the first two days and 6-hourly
 * beyond that, so the match window widens for distant targets rather than using one
 * fixed tolerance — a target that lands between two 6-hourly points still needs to
 * resolve to the nearer one instead of coming back empty.
 */
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  let hoursAhead = parseFloat(params.hours ?? "1");
  if (Number.isNaN(hoursAhead)) hoursAhead = 1;
  hoursAhead = Math.max(0, Math.min(72, hoursAhead));

  const region = params.region || null;
  const stations = region ? allStations.filter((s) => s.region === region) : overview;

  const target = Date.now() + hoursAhead * 3600 * 1000;
  const maxDelta = hoursAhead <= 48 ? 90 : 210;
  const results = await Promise.all(stations.map((station) => fetchOne(station, target, maxDelta)));
  return json({ stations: results, hours_ahead: hoursAhead, region });
};

async function fetchOne(station, targetMs, maxDelta) {
  try {
    const points = await fetchVedur(station.id);
    const hit = nearest(points, targetMs, maxDelta);
    return {
      id: station.id,
      name: station.name,
      region: station.region,
      lat: station.lat ?? null,
      lon: station.lon ?? null,
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
