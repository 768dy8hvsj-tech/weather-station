# Weather Consensus

Blends two independent forecast sources for a place in Iceland into one "most likely" view:

- **yr.no** (MET Norway Locationforecast API) — global, lat/lon based.
- **vedur.is** (Icelandic Met Office xmlweather API) — Iceland only, ~240 named stations.

For each hour, the app shows both sources side by side plus a consensus (average) temperature
and wind, with a colored dot showing how much the two sources disagree (green = close, amber/red
= diverging — a rough confidence signal).

Locations not covered by a vedur.is station still work, falling back to yr.no alone (labeled
"1 source").

## Why no Node/build step

This machine has no Node.js installed, so the app is plain HTML/CSS/JS served by a small
Python **standard-library-only** HTTP server — no `npm install`, no bundler. The only
non-stdlib dependency is `certifi`, needed because this Python install doesn't ship system
CA certificates (a known python.org-on-macOS quirk):

```bash
pip3 install --user certifi
```

## Run it

```bash
python3 server.py
```

Then open http://localhost:8787

## Notes / known limitations

- **belgingur.is** and **blika.is** were considered but skipped: belgingur's API requires paid
  `client_id`/`client_key` credentials, and blika.is has no public API (forecast data is
  server-rendered, no stable JSON endpoint to call). See conversation history for details if
  you get access to either later — `server.py` is structured so a third source just needs a
  `fetch_x()` function and a slot in `build_consensus()`.
- Iceland doesn't observe DST and stays on UTC year-round, so the frontend groups/labels hours
  by their UTC date directly rather than converting timezones.
- `vedur-stations.json` was scraped once from vedur.is's station listing page and is static —
  if they add/rename stations it won't pick up changes automatically.
