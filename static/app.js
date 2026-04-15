/**
 * FloodWatch — NE & Yorkshire
 * app.js  |  D3 v7, Open-Meteo API, Flask /predict
 *
 * How it works:
 *  1. On load  → fetch /api/options  (towns, suitability list from model)
 *  2. On click → fetch 7-day weather from Open-Meteo (free, no key needed)
 *               aggregate hourly → daily for humidity & soil moisture
 *  3.          → POST /predict  with the 7 days of weather + context
 *  4.          → render forecast cards + D3 charts
 */

"use strict";

/* ── CONFIG ─────────────────────────────────────────────────────────────────── */

// When running locally via Flask:  API_BASE = ''  (same origin, no CORS issue)
// After deploying to Render, keep it empty — Flask serves static + API together.
// If you ever host the static files separately, set this to your Render URL:
//   const API_BASE = 'https://your-app-name.onrender.com';
const API_BASE = "";

// Town → [latitude, longitude] lookup.
// Covers all plausible top-5 towns from the NE & Yorkshire dataset.
const TOWN_COORDS = {
  "Bradford":             [53.7960, -1.7594],
  "Darlington":           [54.5240, -1.5530],
  "Doncaster":            [53.5228, -1.1285],
  "Durham":               [54.7761, -1.5733],
  "Gateshead":            [54.9526, -1.6014],
  "Halifax":              [53.7213, -1.8641],
  "Harrogate":            [53.9919, -1.5377],
  "Huddersfield":         [53.6458, -1.7850],
  "Kingston upon Hull":   [53.7676, -0.3274],
  "Leeds":                [53.8008, -1.5491],
  "Middlesbrough":        [54.5741, -1.2350],
  "Newcastle upon Tyne":  [54.9783, -1.6178],
  "Scarborough":          [54.2798, -0.3996],
  "Sheffield":            [53.3811, -1.4701],
  "Stockton-on-Tees":     [54.5644, -1.3187],
  "Sunderland":           [54.9058, -1.3813],
  "Wakefield":            [53.6830, -1.4977],
  "York":                 [53.9591, -1.0815],
};

const RISK_COLORS = { Low: "#4ade80", Medium: "#fb923c", High: "#f87171" };
const RISK_ORDER  = ["Low", "Medium", "High"];

/* ── STATE ──────────────────────────────────────────────────────────────────── */
let modelMeta = {};
let weatherData = [];  // raw Open-Meteo daily rows
let predictions = []; // API response

/* ── DOM refs ───────────────────────────────────────────────────────────────── */
const townSel    = document.getElementById("town-select");
const suitSel    = document.getElementById("suit-select");
const forecastBtn= document.getElementById("forecast-btn");
const statusBar  = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const errorBar   = document.getElementById("error-bar");
const errorText  = document.getElementById("error-text");

/* ── INIT ────────────────────────────────────────────────────────────────────── */
(async function init() {
  try {
    const res  = await fetch(`${API_BASE}/api/options`);
    const data = await res.json();
    modelMeta  = data;

    // Populate town dropdown (intersect with coords we know)
    const towns = (data.towns || []).filter(t => TOWN_COORDS[t]);
    towns.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      townSel.appendChild(opt);
    });
    // If no towns from model, fall back to all known coords
    if (!towns.length) {
      Object.keys(TOWN_COORDS).sort().forEach(t => {
        const opt = document.createElement("option");
        opt.value = t; opt.textContent = t;
        townSel.appendChild(opt);
      });
    }

    // Populate suitability dropdown
    const suits = data.suitability_types || [];
    suits.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      suitSel.appendChild(opt);
    });
    if (suits.length) suitSel.value = suits[0];

    // Badge
    document.getElementById("model-name-badge").textContent =
      `${data.model_name || "Model"} · F1 ${(data.test_f1 || 0).toFixed(3)}`;

    checkReady();
  } catch (e) {
    showError("Could not reach the API. Is Flask running? → python api.py");
  }
})();

townSel.addEventListener("change", checkReady);
suitSel.addEventListener("change", checkReady);
forecastBtn.addEventListener("click", runForecast);

function checkReady() {
  forecastBtn.disabled = !(townSel.value && suitSel.value);
}

/* ── MAIN WORKFLOW ───────────────────────────────────────────────────────────── */
async function runForecast() {
  clearError();
  const town       = townSel.value;
  const suitability= suitSel.value;
  const [lat, lon] = TOWN_COORDS[town] || [54.0, -1.5];

  forecastBtn.disabled = true;

  try {
    // 1 — fetch weather
    setStatus(`Fetching 7-day weather for ${town}…`);
    const daily = await fetchWeather(lat, lon);

    // 2 — predict
    setStatus("Running flood risk model…");
    const days = daily.map(d => ({
      ...d,
      latitude:   lat,
      longitude:  lon,
      town:       town,
      suitability: suitability,
    }));
    const resp = await fetch(`${API_BASE}/predict`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ days }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.message || resp.statusText);
    }
    const result = await resp.json();
    if (result.status !== "ok") throw new Error(result.message);

    predictions = result.predictions;
    weatherData = daily;

    // 3 — render
    hideStatus();
    renderSummary(town, suitability);
    renderCards(daily, predictions);
    renderRiskChart(predictions);
    renderWeatherChart(daily);

    showSections();

  } catch (e) {
    hideStatus();
    showError(e.message);
  } finally {
    forecastBtn.disabled = false;
  }
}

/* ── OPEN-METEO ─────────────────────────────────────────────────────────────── */
async function fetchWeather(lat, lon) {
  const dailyParams = [
    "temperature_2m_mean",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "rain_sum",
    "snowfall_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
  ].join(",");
  const hourlyParams = "relative_humidity_2m,soil_moisture_0_to_1cm";

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=${dailyParams}` +
    `&hourly=${hourlyParams}` +
    `&timezone=Europe%2FLondon` +
    `&forecast_days=7`;

  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  const json = await res.json();

  // Aggregate hourly humidity & soil moisture → daily means
  const hourlyDates   = json.hourly.time;          // "2025-04-15T00:00"
  const hourlyHumid   = json.hourly.relative_humidity_2m;
  const hourlySoil    = json.hourly.soil_moisture_0_to_1cm;

  const dailyHumid = {};
  const dailySoil  = {};
  hourlyDates.forEach((t, i) => {
    const day = t.slice(0, 10);
    if (!dailyHumid[day]) { dailyHumid[day] = []; dailySoil[day] = []; }
    if (hourlyHumid[i] !== null) dailyHumid[day].push(hourlyHumid[i]);
    if (hourlySoil[i]  !== null) dailySoil[day].push(hourlySoil[i]);
  });
  const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

  return json.daily.time.map((date, i) => ({
    date,
    temp_mean:         json.daily.temperature_2m_mean[i]  ?? 0,
    temp_max:          json.daily.temperature_2m_max[i]   ?? 0,
    temp_min:          json.daily.temperature_2m_min[i]   ?? 0,
    precipitation_sum: json.daily.precipitation_sum[i]    ?? 0,
    rain_sum:          json.daily.rain_sum[i]              ?? 0,
    snowfall_sum:      json.daily.snowfall_sum[i]          ?? 0,
    wind_speed_max:    json.daily.wind_speed_10m_max[i]   ?? 0,
    wind_gusts_max:    json.daily.wind_gusts_10m_max[i]   ?? 0,
    humidity_mean:     mean(dailyHumid[date] || []),
    soil_moisture_mean: mean(dailySoil[date] || []),
  }));
}

/* ── RENDER: Summary ribbon ─────────────────────────────────────────────────── */
function renderSummary(town, suit) {
  const labels = predictions.map(p => p.predicted_label);
  const score  = { Low: 0, Medium: 1, High: 2 };
  const peak   = labels.reduce((a, b) => score[b] > score[a] ? b : a, "Low");
  const highN  = labels.filter(l => l === "High").length;

  document.getElementById("sum-loc-val").textContent    = `${town} · ${suit}`;
  document.getElementById("sum-peak-val").textContent   = peak;
  document.getElementById("sum-high-val").textContent   = `${highN} / 7 days`;
  document.getElementById("sum-model-val").textContent  = modelMeta.model_name || "—";
  document.getElementById("sum-peak-icon").textContent  =
    peak === "High" ? "🚨" : peak === "Medium" ? "⚠️" : "✅";

  const peakEl = document.getElementById("sum-peak-val");
  peakEl.style.color = RISK_COLORS[peak] || "inherit";
}

/* ── RENDER: Day cards ──────────────────────────────────────────────────────── */
function weatherIcon(d) {
  if ((d.snowfall_sum ?? 0) > 0)         return "❄️";
  if ((d.precipitation_sum ?? 0) > 15)   return "⛈️";
  if ((d.precipitation_sum ?? 0) > 5)    return "🌧️";
  if ((d.precipitation_sum ?? 0) > 0.5)  return "🌦️";
  if ((d.humidity_mean ?? 0) > 75)       return "⛅";
  return "☀️";
}

function renderCards(daily, preds) {
  const container = document.getElementById("forecast-cards");
  container.innerHTML = "";

  preds.forEach((p, i) => {
    const d     = daily[i];
    const label = p.predicted_label;
    const conf  = p.probabilities[label] ?? 0;
    const date  = new Date(p.date + "T12:00:00");
    const dayNm = date.toLocaleDateString("en-GB", { weekday: "short" });
    const dayDt = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

    const card = document.createElement("div");
    card.className = `day-card risk-${label.toLowerCase()}`;
    card.style.animationDelay = `${i * 60}ms`;
    card.innerHTML = `
      <div class="day-name">${dayNm}</div>
      <div class="day-date">${dayDt}</div>
      <div class="day-icon">${weatherIcon(d)}</div>
      <div class="day-temp"><strong>${Math.round(d.temp_max ?? 0)}°</strong> / ${Math.round(d.temp_min ?? 0)}°C</div>
      <div class="day-precip">💧 ${(d.precipitation_sum ?? 0).toFixed(1)} mm</div>
      <div class="day-wind">💨 ${Math.round(d.wind_speed_max ?? 0)} km/h</div>
      <div class="day-humid">💦 ${Math.round(d.humidity_mean ?? 0)}%</div>
      <div class="risk-badge ${label.toLowerCase()}">${label}</div>
      <div class="prob-bar-wrap">
        <div class="prob-bar-fill"
             style="width:${(conf*100).toFixed(0)}%;
                    background:${RISK_COLORS[label]}"></div>
      </div>
    `;
    container.appendChild(card);
  });
}

/* ── RENDER: Risk Probability Chart (D3 grouped bars) ──────────────────────── */
function renderRiskChart(preds) {
  const container = document.getElementById("risk-chart");
  container.innerHTML = "";

  const W = container.clientWidth || 900;
  const H = 300;
  const margin = { top: 20, right: 20, bottom: 50, left: 45 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top  - margin.bottom;

  const svg = d3.select("#risk-chart").append("svg")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const dates  = preds.map(p => p.date);
  const x0     = d3.scaleBand().domain(dates).range([0, iW]).paddingInner(0.25);
  const x1     = d3.scaleBand().domain(RISK_ORDER).range([0, x0.bandwidth()]).padding(0.05);
  const y      = d3.scaleLinear().domain([0, 1]).range([iH, 0]);

  // Grid
  g.append("g").attr("class","grid")
    .call(d3.axisLeft(y).ticks(5).tickSize(-iW).tickFormat(""))
    .call(g => g.select(".domain").remove());

  // Axes
  g.append("g").attr("class","axis")
    .attr("transform",`translate(0,${iH})`)
    .call(d3.axisBottom(x0).tickFormat(d => {
      const dt = new Date(d + "T12:00");
      return dt.toLocaleDateString("en-GB",{weekday:"short", day:"numeric", month:"short"});
    }))
    .call(g => g.select(".domain").remove())
    .selectAll("text").attr("transform","rotate(-25)").style("text-anchor","end");

  g.append("g").attr("class","axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")))
    .call(g => g.select(".domain").remove());

  // Y label
  g.append("text")
    .attr("transform","rotate(-90)")
    .attr("x",-iH/2).attr("y",-35)
    .attr("text-anchor","middle")
    .attr("fill","#94a3b8").attr("font-size","11px")
    .text("Probability");

  // Tooltip
  const tip = d3.select("body").append("div").attr("class","d3-tooltip").style("opacity",0);

  // Bars
  const dayGs = g.selectAll(".day-group")
    .data(preds).enter().append("g").attr("class","day-group")
    .attr("transform", d => `translate(${x0(d.date)},0)`);

  dayGs.selectAll("rect")
    .data(d => RISK_ORDER.map(risk => ({
      risk, prob: d.probabilities[risk] ?? 0, date: d.date, label: d.predicted_label
    })))
    .enter().append("rect")
      .attr("x",      d => x1(d.risk))
      .attr("width",  x1.bandwidth())
      .attr("y",      iH)              // start at bottom for animation
      .attr("height", 0)
      .attr("fill",   d => RISK_COLORS[d.risk])
      .attr("rx", 3)
      .attr("opacity", d => d.risk === d.label ? 1 : 0.45)
      .on("mouseover", (event, d) => {
        tip.style("opacity",1)
          .html(`<strong>${d.date}</strong>${d.risk}: ${(d.prob*100).toFixed(1)}%`);
      })
      .on("mousemove", event => {
        tip.style("left",(event.pageX+12)+"px").style("top",(event.pageY-28)+"px");
      })
      .on("mouseout", () => tip.style("opacity",0))
      // animate bars up
      .transition().duration(600).delay((_, i) => i * 40)
        .attr("y",      d => y(d.prob))
        .attr("height", d => iH - y(d.prob));

  // Legend
  const legend = d3.select("#risk-chart").append("div").attr("class","chart-legend");
  RISK_ORDER.forEach(r => {
    legend.append("span")
      .html(`<span class="legend-dot" style="background:${RISK_COLORS[r]}"></span>${r}`)
      .style("color","#94a3b8").style("font-size","0.82rem");
  });
}

/* ── RENDER: Weather Chart (D3 multi-line) ──────────────────────────────────── */
function renderWeatherChart(daily) {
  const container = document.getElementById("weather-chart");
  container.innerHTML = "";

  const W = container.clientWidth || 900;
  const H = 240;
  const margin = { top: 20, right: 60, bottom: 50, left: 45 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top  - margin.bottom;

  const svg = d3.select("#weather-chart").append("svg")
    .attr("viewBox",`0 0 ${W} ${H}`)
    .attr("preserveAspectRatio","xMidYMid meet");

  const g = svg.append("g").attr("transform",`translate(${margin.left},${margin.top})`);

  const x  = d3.scalePoint().domain(daily.map(d=>d.date)).range([0,iW]).padding(0.3);

  // Precipitation (bar) — left axis
  const yP = d3.scaleLinear()
    .domain([0, d3.max(daily, d => d.precipitation_sum ?? 0) * 1.3 || 10])
    .range([iH, 0]);

  // Humidity (line) — right axis
  const yH = d3.scaleLinear().domain([0, 100]).range([iH, 0]);

  // Grid
  g.append("g").attr("class","grid")
    .call(d3.axisLeft(yP).ticks(4).tickSize(-iW).tickFormat(""))
    .call(g => g.select(".domain").remove());

  // Precip bars
  const bw = Math.min(x.step() * 0.4, 30);
  g.selectAll(".precip-bar")
    .data(daily).enter().append("rect")
      .attr("x",    d => (x(d.date) ?? 0) - bw/2)
      .attr("width", bw)
      .attr("y",     iH)
      .attr("height", 0)
      .attr("fill","#38bdf8").attr("opacity",0.55).attr("rx",2)
      .transition().duration(600).delay((_,i)=>i*60)
        .attr("y",      d => yP(d.precipitation_sum ?? 0))
        .attr("height", d => iH - yP(d.precipitation_sum ?? 0));

  // Humidity line
  const humidLine = d3.line()
    .x(d => x(d.date) ?? 0)
    .y(d => yH(d.humidity_mean ?? 0))
    .curve(d3.curveCatmullRom.alpha(0.5));

  const path = g.append("path")
    .datum(daily)
    .attr("fill","none")
    .attr("stroke","#fb923c").attr("stroke-width",2.2)
    .attr("d", humidLine);

  const totalLen = path.node().getTotalLength();
  path.attr("stroke-dasharray",totalLen)
    .attr("stroke-dashoffset",totalLen)
    .transition().duration(900).ease(d3.easeLinear)
      .attr("stroke-dashoffset",0);

  g.selectAll(".humid-dot")
    .data(daily).enter().append("circle")
      .attr("cx", d => x(d.date) ?? 0)
      .attr("cy", d => yH(d.humidity_mean ?? 0))
      .attr("r",3.5).attr("fill","#fb923c").attr("opacity",0)
      .transition().delay(900).duration(200)
        .attr("opacity",1);

  // Axes
  g.append("g").attr("class","axis").attr("transform",`translate(0,${iH})`)
    .call(d3.axisBottom(x).tickFormat(d => {
      const dt = new Date(d + "T12:00");
      return dt.toLocaleDateString("en-GB",{weekday:"short"});
    }))
    .call(g => g.select(".domain").remove());

  g.append("g").attr("class","axis")
    .call(d3.axisLeft(yP).ticks(4).tickFormat(d => `${d}mm`))
    .call(g => g.select(".domain").remove());

  g.append("g").attr("class","axis")
    .attr("transform",`translate(${iW},0)`)
    .call(d3.axisRight(yH).ticks(4).tickFormat(d => `${d}%`))
    .call(g => g.select(".domain").remove());

  // Legend
  const legend = d3.select("#weather-chart").append("div").attr("class","chart-legend");
  legend.append("span")
    .html(`<span class="legend-dot" style="background:#38bdf8;opacity:0.7"></span>Precipitation (mm)`)
    .style("color","#94a3b8").style("font-size","0.82rem");
  legend.append("span")
    .html(`<span class="legend-dot" style="background:#fb923c"></span>Humidity (%)`)
    .style("color","#94a3b8").style("font-size","0.82rem");
}

/* ── HELPERS ─────────────────────────────────────────────────────────────────── */
function showSections() {
  document.getElementById("summary-section").classList.remove("hidden");
  document.getElementById("forecast-section").classList.remove("hidden");
  document.getElementById("chart-section").classList.remove("hidden");
  document.getElementById("summary-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setStatus(msg) {
  statusText.textContent = msg;
  statusBar.classList.remove("hidden");
}
function hideStatus() { statusBar.classList.add("hidden"); }

function showError(msg) {
  errorText.textContent = msg;
  errorBar.classList.remove("hidden");
}
function clearError() { errorBar.classList.add("hidden"); }
