// Split out from forecast.js: this call alone takes ~3.3s (Open-Meteo's Previous Runs
// API is just slow), versus ~0.9s for everything else forecast.js fetches combined —
// blocking the main forecast response on it would erase most of the benefit of
// parallelizing the other calls. The frontend fetches this separately after the main
// table renders, so a slow reliability panel doesn't hold up the rest of the page.

const OPEN_METEO_MODELS = [
  ["ecmwf_ifs025", "ecmwf"],
  ["gfs_seamless", "gfs"],
  ["icon_seamless", "icon"],
];

const RELIABILITY_WINDOW_HOURS = 24;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const lat = parseFloat(params.lat);
  const lon = parseFloat(params.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return json({ error: "Missing or invalid 'lat'/'lon' query parameters" }, 400);
  }

  let reliability = null;
  try {
    reliability = await fetchReliability(lat, lon);
  } catch (e) {
    reliability = null;
  }
  return json({ reliability });
};

/**
 * 24h backtest of each Open-Meteo model's own short-range skill.
 *
 * Open-Meteo's Previous Runs API can return what a model predicted N days before
 * a given hour (temperature_2m_previous_day1 = predicted 24h ahead of that hour).
 * We don't have an independent observation history to compare against (vedur.is's
 * obs endpoint only exposes the latest reading, not a time series), so — per
 * Open-Meteo's own documented method — we compare each 24h-ahead prediction
 * against that same model's current/latest run for the same past hour
 * (temperature_2m), which reflects its most up-to-date analysis.
 */
async function fetchReliability(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: "temperature_2m,temperature_2m_previous_day1,wind_speed_10m,wind_speed_10m_previous_day1",
    models: OPEN_METEO_MODELS.map(([modelId]) => modelId).join(","),
    past_days: "2",
    forecast_days: "1",
    timezone: "UTC",
  });
  const res = await fetch(`https://previous-runs-api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const hourly = raw.hourly || {};
  const times = hourly.time || [];

  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const windowStart = now.getTime() - RELIABILITY_WINDOW_HOURS * 3600 * 1000;

  const models = {};
  const tempMaes = [];
  for (const [modelId, key] of OPEN_METEO_MODELS) {
    const actualTemp = hourly[`temperature_2m_${modelId}`];
    const predTemp = hourly[`temperature_2m_previous_day1_${modelId}`];
    const actualWind = hourly[`wind_speed_10m_${modelId}`];
    const predWind = hourly[`wind_speed_10m_previous_day1_${modelId}`];
    if (!actualTemp || !predTemp) continue;

    const tempErrors = [];
    const windErrors = [];
    times.forEach((t, i) => {
      const ts = Date.parse(`${t}:00Z`);
      if (ts < windowStart || ts > now.getTime()) return;
      if (actualTemp[i] !== null && actualTemp[i] !== undefined && predTemp[i] !== null && predTemp[i] !== undefined) {
        tempErrors.push(Math.abs(actualTemp[i] - predTemp[i]));
      }
      if (
        actualWind &&
        predWind &&
        actualWind[i] !== null &&
        actualWind[i] !== undefined &&
        predWind[i] !== null &&
        predWind[i] !== undefined
      ) {
        windErrors.push(Math.abs(actualWind[i] - predWind[i]) / 3.6);
      }
    });

    if (!tempErrors.length) continue;
    models[key] = {
      mae_temp_c: round2(avg(tempErrors)),
      mae_wind_ms: windErrors.length ? round2(avg(windErrors)) : null,
      sample_hours: tempErrors.length,
    };
    tempMaes.push(models[key].mae_temp_c);
  }

  if (!Object.keys(models).length) return null;

  return {
    window_hours: RELIABILITY_WINDOW_HOURS,
    avg_mae_temp_c: round2(avg(tempMaes)),
    models,
  };
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const round2 = (n) => Math.round(n * 100) / 100;

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
