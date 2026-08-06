/**
 * Hand-rolled SVG chart spanning the whole visible forecast (all days at once, not
 * per-day like the tables below it) — a temperature line, sky-condition icons, wind
 * direction/force arrows, precipitation bars, and shaded best-golf-window bands all
 * sharing one timeline. Reuses app.js's hover-panel machinery (same page, same script
 * scope) and icons.js's icon set so the chart looks and behaves like the rest of the
 * app rather than a bolted-on library widget.
 */
const CHART_VIEW_WIDTH = 900;
const CHART_HEIGHT = 240;
const CHART_MARGIN = { top: 4, right: 12, bottom: 22, left: 34 };
const CHART_SKY_LANE = 24;
const CHART_WIND_LANE = 20;
const CHART_PRECIP_LANE = 30;

// WEATHER_ICONS/WIND_ARROW entries are full `<svg viewBox="0 0 24 24">` elements with no
// explicit width/height (fine as block-level icons, where CSS sizes them) — nested raw
// inside another SVG's <g> they have no intrinsic size to fall back to and balloon to
// fill the parent viewport, so give each an explicit size before embedding here.
function sizedIcon(iconSvg) {
  return iconSvg.replace("<svg ", '<svg width="24" height="24" ');
}
const WIND_ARROW_SIZED = sizedIcon(WIND_ARROW);
const SKY_ICONS_SIZED = Object.fromEntries(Object.entries(WEATHER_ICONS).map(([k, v]) => [k, sizedIcon(v)]));

function renderForecastChart(containerId, hours, opts) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const validHours = (hours || []).filter((h) => h.consensus && h.consensus.temp_c !== null && h.consensus.temp_c !== undefined);
  if (validHours.length < 2) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");

  const { daylight = [], bestWindowsByDay = new Map(), hasGolf = false } = opts || {};

  const plotTop = CHART_MARGIN.top + CHART_SKY_LANE + CHART_WIND_LANE;
  const plotBottom = CHART_HEIGHT - CHART_MARGIN.bottom - CHART_PRECIP_LANE;
  const plotHeight = plotBottom - plotTop;
  const plotLeft = CHART_MARGIN.left;
  const plotRight = CHART_VIEW_WIDTH - CHART_MARGIN.right;
  const plotWidth = plotRight - plotLeft;

  const times = hours.map((h) => Date.parse(h.time));
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const xScale = (t) => plotLeft + ((t - t0) / (t1 - t0 || 1)) * plotWidth;

  const temps = validHours.map((h) => h.consensus.temp_c);
  let tempMin = Math.min(...temps);
  let tempMax = Math.max(...temps);
  if (tempMin === tempMax) {
    tempMin -= 1;
    tempMax += 1;
  }
  const tempPad = (tempMax - tempMin) * 0.2;
  tempMin -= tempPad;
  tempMax += tempPad;
  const yScale = (v) => plotTop + plotHeight - ((v - tempMin) / (tempMax - tempMin)) * plotHeight;

  const precipMax = Math.max(1, ...hours.map((h) => (h.consensus.precip && h.consensus.precip.mm) || 0));
  const precipTop = plotBottom + 10;
  const precipLaneUsable = CHART_PRECIP_LANE - 6;
  const precipScale = (mm) => (mm / precipMax) * precipLaneUsable;

  const linePoints = [];
  hours.forEach((h, i) => {
    if (h.consensus.temp_c === null || h.consensus.temp_c === undefined) return;
    linePoints.push([xScale(times[i]), yScale(h.consensus.temp_c)]);
  });
  const linePath = linePoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const areaPath = linePoints.length
    ? `${linePath} L ${linePoints[linePoints.length - 1][0].toFixed(1)} ${plotBottom.toFixed(1)} ` +
      `L ${linePoints[0][0].toFixed(1)} ${plotBottom.toFixed(1)} Z`
    : "";

  const bestBands = [...bestWindowsByDay.values()]
    .filter(Boolean)
    .map((bw) => {
      const x0 = xScale(Date.parse(bw.times[0]));
      const x1 = xScale(Date.parse(bw.times[bw.times.length - 1]) + 3600 * 1000);
      return `<rect class="chart-best-band" x="${x0.toFixed(1)}" y="${plotTop}" width="${Math.max(0, x1 - x0).toFixed(1)}" height="${plotHeight}" />`;
    })
    .join("");

  const dayKeys = [...new Set(hours.map((h) => h.time.slice(0, 10)))];
  const dayGridlines = dayKeys
    .map((dayKey) => {
      const dayStart = Date.parse(`${dayKey}T00:00:00Z`);
      if (dayStart <= t0 || dayStart >= t1) return "";
      const x = xScale(dayStart);
      return `<line class="chart-gridline" x1="${x.toFixed(1)}" y1="${CHART_MARGIN.top}" x2="${x.toFixed(1)}" y2="${plotBottom}" />`;
    })
    .join("");
  const dayLabels = dayKeys
    .map((dayKey) => {
      const dayHours = hours.filter((h) => h.time.slice(0, 10) === dayKey);
      const midTime = Date.parse(dayHours[Math.floor(dayHours.length / 2)].time);
      const x = xScale(midTime);
      const label = formatDayTitle(dayKey).split(",")[0];
      return `<text class="chart-day-label" x="${x.toFixed(1)}" y="${CHART_HEIGHT - 6}" text-anchor="middle">${label}</text>`;
    })
    .join("");

  const iconEvery = Math.max(1, Math.round(hours.length / 14));
  const windY = CHART_MARGIN.top + CHART_SKY_LANE + CHART_WIND_LANE / 2;
  const windArrows = hours
    .map((h, i) => {
      if (i % iconEvery !== 0) return "";
      const ms = h.consensus.wind_ms;
      if (ms === null || ms === undefined) return "";
      const dir = h.consensus.wind_dir_deg;
      const b = beaufortForce(ms);
      const opacity = b ? (0.3 + (b.force / 12) * 0.7).toFixed(2) : "0.4";
      const x = xScale(times[i]);
      const rotate = dir !== null && dir !== undefined ? (dir + 180) % 360 : 0;
      return `<g transform="translate(${x.toFixed(1)},${windY.toFixed(1)}) rotate(${rotate})" opacity="${opacity}"><g transform="translate(-6,-6) scale(0.5)">${WIND_ARROW_SIZED}</g></g>`;
    })
    .join("");

  const skyY = CHART_MARGIN.top + CHART_SKY_LANE / 2;
  const skyIcons = hours
    .map((h, i) => {
      if (i % iconEvery !== 0) return "";
      const c = h.consensus;
      if (c.cloud_cover_pct === null || c.cloud_cover_pct === undefined) return "";
      const category = skyCategory({ cloudCoverPct: c.cloud_cover_pct, precipType: c.precip && c.precip.type });
      const icon = SKY_ICONS_SIZED[category] || SKY_ICONS_SIZED.unknown;
      const x = xScale(times[i]);
      return `<g class="chart-sky-icon icon-${category}" transform="translate(${x.toFixed(1)},${skyY.toFixed(1)})"><g transform="translate(-8,-8) scale(0.67)">${icon}</g></g>`;
    })
    .join("");

  const barWidth = Math.max(2, plotWidth / hours.length - 1);
  const precipBars = hours
    .map((h, i) => {
      const mm = h.consensus.precip && h.consensus.precip.mm;
      if (!mm) return "";
      const x = xScale(times[i]);
      const barH = precipScale(mm);
      const cls = h.consensus.precip.type === "snow" ? "chart-precip-bar-snow" : "chart-precip-bar";
      return `<rect class="${cls}" x="${(x - barWidth / 2).toFixed(1)}" y="${(precipTop + (precipLaneUsable - barH)).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, barH).toFixed(1)}" />`;
    })
    .join("");

  const tempTickCount = 3;
  const tempTicks = [];
  for (let i = 0; i < tempTickCount; i++) {
    const v = tempMin + tempPad + ((tempMax - tempPad - (tempMin + tempPad)) * i) / (tempTickCount - 1);
    tempTicks.push(v);
  }
  const tempAxisLabels = tempTicks
    .map((v) => `<text class="chart-axis-label" x="${(plotLeft - 6).toFixed(1)}" y="${(yScale(v) + 3).toFixed(1)}" text-anchor="end">${Math.round(v)}°</text>`)
    .join("");

  const hoverDots = hours
    .map((h, i) => {
      if (h.consensus.temp_c === null || h.consensus.temp_c === undefined) return "";
      const x = xScale(times[i]);
      const y = yScale(h.consensus.temp_c);
      return `<circle class="chart-hover-dot" data-idx="${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" />`;
    })
    .join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${CHART_VIEW_WIDTH} ${CHART_HEIGHT}" class="forecast-chart-svg" preserveAspectRatio="none">
      ${bestBands}
      ${dayGridlines}
      <path class="chart-temp-area" d="${areaPath}"></path>
      <path class="chart-temp-line" d="${linePath}"></path>
      ${precipBars}
      <g class="chart-wind-lane">${windArrows}</g>
      ${skyIcons}
      ${tempAxisLabels}
      ${dayLabels}
      ${hoverDots}
    </svg>
  `;

  el.querySelectorAll(".chart-hover-dot").forEach((dot) => {
    const idx = Number(dot.dataset.idx);
    const h = hours[idx];
    dot.addEventListener("mouseenter", () => {
      clearTimeout(hoverHideTimer);
      showHoverPanel(dot, buildChartHoverHtml(h, { daylight, hasGolf }));
    });
    dot.addEventListener("mouseleave", () => {
      hoverHideTimer = setTimeout(hideHoverPanel, 120);
    });
  });
}

function buildChartHoverHtml(h, { daylight, hasGolf }) {
  const timeLabel = new Date(h.time).toLocaleString("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const precip = fmtPrecip(h.consensus.precip);
  const golf = hasGolf ? golfScore(h.consensus, h.time, daylight) : null;
  const c = h.consensus;
  const skyLabel =
    c.cloud_cover_pct === null || c.cloud_cover_pct === undefined
      ? null
      : skyCategory({ cloudCoverPct: c.cloud_cover_pct, precipType: c.precip && c.precip.type })
          .replace("-", " ")
          .replace(/^./, (ch) => ch.toUpperCase());
  const rows = [
    `${fmtTemp(h.consensus.temp_c)} · ${fmtWind(h.consensus.wind_ms)}${h.consensus.wind_dir_compass ? " " + h.consensus.wind_dir_compass : ""}`,
    ...(skyLabel ? [skyLabel] : []),
    precip.text !== "—" ? precip.text : "No precipitation",
  ];
  if (golf) rows.push(`Golf: ${golf.label} (${golf.score}/100)`);
  return `
    <div class="hover-title">${timeLabel} UTC</div>
    <ul class="hover-list">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>
  `;
}
