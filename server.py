"""
Weather consensus backend. Pure standard-library Python (no pip installs required).

Combines several independently-run forecast sources for a given place:
  - MET Norway "Locationforecast" API (api.met.no) — global coverage, lat/lon based.
  - Icelandic Met Office "xmlweather" API (xmlweather.vedur.is) — Iceland only, station based.
  - Open-Meteo (api.open-meteo.com) — keyless proxy in front of several raw global NWP
    models (ECMWF, NOAA GFS, DWD ICON), fetched in one call.

Serves the static frontend from ./public and a small JSON API under /api/*.
"""
import json
import ssl
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PUBLIC_DIR = ROOT / "public"
STATIONS_PATH = ROOT / "vedur-stations.json"
USER_AGENT = "weather-consensus-app/1.0 (personal project; contact hakond@gmail.com)"
PORT = 8787

try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

with open(STATIONS_PATH, encoding="utf-8") as f:
    VEDUR_STATIONS = json.load(f)


def http_get(url: str, headers: dict | None = None, timeout: float = 10) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
        return resp.read()


def search_stations(query: str, limit: int = 8) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    starts = [s for s in VEDUR_STATIONS if s["name"].lower().startswith(q)]
    contains = [s for s in VEDUR_STATIONS if q in s["name"].lower() and s not in starts]
    return (starts + contains)[:limit]


def geocode(query: str, iceland_only: bool = True) -> dict | None:
    """Free-text geocoding via OpenStreetMap Nominatim.

    Small Icelandic place names are often shared by an obscure natural feature
    (a random peak, a stream) and the actual settlement/landmark people mean.
    Nominatim's importance ranking doesn't reliably prefer the latter, so we
    pull a few candidates and skip bare "natural" features when a better
    option exists.
    """
    params = {"q": query, "format": "jsonv2", "limit": 5}
    if iceland_only:
        params["countrycodes"] = "is"
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    try:
        data = json.loads(http_get(url))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None
    if not data:
        return None
    non_natural = [hit for hit in data if hit.get("category") != "natural"]
    hit = non_natural[0] if non_natural else data[0]
    return {"lat": float(hit["lat"]), "lon": float(hit["lon"]), "display_name": hit["display_name"]}


def fetch_yrno(lat: float, lon: float) -> list[dict]:
    """Returns a list of {time, temp_c, wind_ms, precip_mm, symbol} at hourly resolution."""
    url = (
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?"
        + urllib.parse.urlencode({"lat": f"{lat:.4f}", "lon": f"{lon:.4f}"})
    )
    raw = json.loads(http_get(url))
    out = []
    for entry in raw["properties"]["timeseries"]:
        time = entry["time"]
        instant = entry["data"]["instant"]["details"]
        next1h = entry["data"].get("next_1_hours", {})
        out.append(
            {
                "time": time,
                "temp_c": instant.get("air_temperature"),
                "wind_ms": instant.get("wind_speed"),
                "precip_mm": next1h.get("details", {}).get("precipitation_amount"),
                "symbol": next1h.get("summary", {}).get("symbol_code"),
            }
        )
    return out


def fetch_vedur(station_id: int) -> list[dict]:
    """Returns a list of {time, temp_c, wind_ms, direction, condition} for a vedur.is station."""
    url = (
        "https://xmlweather.vedur.is/?"
        + urllib.parse.urlencode(
            {"op_w": "xml", "type": "forec", "lang": "en", "view": "xml", "ids": station_id}
        )
    )
    raw = http_get(url)
    root = ET.fromstring(raw)
    station = root.find("station")
    out = []
    if station is None:
        return out
    for fc in station.findall("forecast"):
        ftime = fc.findtext("ftime")
        if not ftime:
            continue
        dt = datetime.strptime(ftime, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        wind = fc.findtext("F")
        temp = fc.findtext("T")
        out.append(
            {
                "time": dt.isoformat(),
                "temp_c": float(temp) if temp not in (None, "") else None,
                "wind_ms": float(wind) if wind not in (None, "") else None,
                "direction": fc.findtext("D"),
                "condition": fc.findtext("W"),
            }
        )
    return out


OPEN_METEO_MODELS = [("ecmwf_ifs025", "ecmwf"), ("gfs_seamless", "gfs"), ("icon_seamless", "icon")]


def fetch_openmeteo(lat: float, lon: float) -> dict[str, list[dict]]:
    """Returns {model_key: [{time, temp_c, wind_ms, precip_mm, snow_cm}, ...]} for each model
    in OPEN_METEO_MODELS. One HTTP call regardless of how many models are requested.

    "precipitation" is liquid-equivalent (mm, rain+snow combined); "snowfall" is snow
    accumulation specifically (cm) — together they let us tell rain from snow, which
    vedur.is's forecast API doesn't expose as a number at all (only a text description).
    """
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(
        {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
            "hourly": "temperature_2m,wind_speed_10m,precipitation,snowfall",
            "models": ",".join(model_id for model_id, _ in OPEN_METEO_MODELS),
            "timezone": "UTC",
            "forecast_days": 4,
        }
    )
    raw = json.loads(http_get(url))
    hourly = raw.get("hourly", {})
    times = hourly.get("time", [])

    out = {}
    for model_id, key in OPEN_METEO_MODELS:
        temps = hourly.get(f"temperature_2m_{model_id}")
        winds = hourly.get(f"wind_speed_10m_{model_id}")
        precs = hourly.get(f"precipitation_{model_id}")
        snows = hourly.get(f"snowfall_{model_id}")
        if temps is None:
            continue
        points = []
        for i, t in enumerate(times):
            wind_kmh = winds[i] if winds and i < len(winds) else None
            points.append(
                {
                    "time": f"{t}:00Z",
                    "temp_c": temps[i] if i < len(temps) else None,
                    "wind_ms": round(wind_kmh / 3.6, 1) if wind_kmh is not None else None,
                    "precip_mm": precs[i] if precs and i < len(precs) else None,
                    "snow_cm": snows[i] if snows and i < len(snows) else None,
                }
            )
        out[key] = points
    return out


def nearest(points: list[dict], target: datetime, max_delta_minutes: int = 40) -> dict | None:
    best, best_delta = None, None
    for p in points:
        t = datetime.fromisoformat(p["time"])
        delta = abs((t - target).total_seconds())
        if best_delta is None or delta < best_delta:
            best, best_delta = p, delta
    if best is not None and best_delta <= max_delta_minutes * 60:
        return best
    return None


SNOW_HINTS = ("snow", "sleet")


def resolve_precip(yrno_symbol, vedur_condition, precip_mm_values, snow_cm_values):
    """vedur.is only gives a text condition, no numeric precip — so "type" leans on
    Open-Meteo's snowfall (when available) and falls back to symbol/condition text
    hints. This is a simple heuristic, not a real precip-type model."""
    mm = round(sum(precip_mm_values) / len(precip_mm_values), 1) if precip_mm_values else None
    snow_cm = round(sum(snow_cm_values) / len(snow_cm_values), 1) if snow_cm_values else None

    text_says_snow = any(
        s and any(h in s.lower() for h in SNOW_HINTS) for s in [yrno_symbol, vedur_condition]
    )
    if (snow_cm and snow_cm > 0.05) or (snow_cm is None and text_says_snow):
        precip_type = "snow"
    elif mm and mm > 0.05:
        precip_type = "rain"
    else:
        precip_type = "none"

    return {"mm": mm, "snow_cm": snow_cm, "type": precip_type, "source_count": len(precip_mm_values)}


def build_consensus(
    yrno_points: list[dict], vedur_points: list[dict], openmeteo_points: dict[str, list[dict]]
) -> list[dict]:
    hours = []
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=72)
    for yp in yrno_points:
        t = datetime.fromisoformat(yp["time"])
        if t < now - timedelta(hours=1) or t > horizon:
            continue
        vp = nearest(vedur_points, t) if vedur_points else None
        om = {}
        for key, points in openmeteo_points.items():
            p = nearest(points, t)
            if p:
                om[key] = p

        temps = [yp.get("temp_c"), vp.get("temp_c") if vp else None] + [p.get("temp_c") for p in om.values()]
        winds = [yp.get("wind_ms"), vp.get("wind_ms") if vp else None] + [p.get("wind_ms") for p in om.values()]
        temps = [v for v in temps if v is not None]
        winds = [v for v in winds if v is not None]

        precip_mm_values = [yp.get("precip_mm")] + [p.get("precip_mm") for p in om.values()]
        precip_mm_values = [v for v in precip_mm_values if v is not None]
        snow_cm_values = [p.get("snow_cm") for p in om.values() if p.get("snow_cm") is not None]
        precip = resolve_precip(yp.get("symbol"), vp.get("condition") if vp else None, precip_mm_values, snow_cm_values)

        hours.append(
            {
                "time": yp["time"],
                "sources": {
                    "yrno": {
                        "temp_c": yp.get("temp_c"),
                        "wind_ms": yp.get("wind_ms"),
                        "precip_mm": yp.get("precip_mm"),
                        "symbol": yp.get("symbol"),
                    },
                    "vedur": (
                        {
                            "temp_c": vp.get("temp_c"),
                            "wind_ms": vp.get("wind_ms"),
                            "condition": vp.get("condition"),
                            "direction": vp.get("direction"),
                        }
                        if vp
                        else None
                    ),
                    "openmeteo": (
                        {
                            key: {
                                "temp_c": p.get("temp_c"),
                                "wind_ms": p.get("wind_ms"),
                                "precip_mm": p.get("precip_mm"),
                                "snow_cm": p.get("snow_cm"),
                            }
                            for key, p in om.items()
                        }
                        if om
                        else None
                    ),
                },
                "consensus": {
                    "temp_c": round(sum(temps) / len(temps), 1) if temps else None,
                    "temp_spread": round(max(temps) - min(temps), 1) if len(temps) > 1 else 0,
                    "wind_ms": round(sum(winds) / len(winds), 1) if winds else None,
                    "source_count": len(temps),
                    "precip": precip,
                },
            }
        )
    return hours


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._json({"error": message}, status)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/search":
            q = (qs.get("q") or [""])[0]
            matches = search_stations(q)
            self._json({"matches": matches})
            return

        if parsed.path == "/api/forecast":
            name = (qs.get("name") or [""])[0].strip()
            station_id = (qs.get("station_id") or [None])[0]
            if not name:
                self._error(400, "Missing 'name' query parameter")
                return

            geo = geocode(name, iceland_only=True) or geocode(name, iceland_only=False)
            if geo is None:
                self._error(404, f"Could not locate '{name}'")
                return

            try:
                yrno_points = fetch_yrno(geo["lat"], geo["lon"])
            except Exception as e:
                self._error(502, f"MET Norway fetch failed: {e}")
                return

            vedur_points = []
            if station_id:
                try:
                    vedur_points = fetch_vedur(int(station_id))
                except Exception:
                    vedur_points = []

            try:
                openmeteo_points = fetch_openmeteo(geo["lat"], geo["lon"])
            except Exception:
                openmeteo_points = {}

            hours = build_consensus(yrno_points, vedur_points, openmeteo_points)

            source_labels = ["yr.no"]
            if vedur_points:
                source_labels.append("vedur.is")
            if openmeteo_points:
                source_labels.append("Open-Meteo (" + "/".join(k.upper() for k in openmeteo_points) + ")")

            self._json(
                {
                    "location": {
                        "name": name,
                        "lat": geo["lat"],
                        "lon": geo["lon"],
                        "resolved_name": geo["display_name"],
                        "vedur_station_id": int(station_id) if station_id else None,
                        "source_count": 1 + (1 if vedur_points else 0) + len(openmeteo_points),
                        "source_labels": source_labels,
                    },
                    "hours": hours,
                }
            )
            return

        # Static file serving
        rel = parsed.path.lstrip("/") or "index.html"
        file_path = (PUBLIC_DIR / rel).resolve()
        if PUBLIC_DIR not in file_path.parents and file_path != PUBLIC_DIR:
            self._error(403, "Forbidden")
            return
        if not file_path.exists() or file_path.is_dir():
            file_path = PUBLIC_DIR / "index.html"
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Weather consensus app running at http://127.0.0.1:{PORT}")
    server.serve_forever()
