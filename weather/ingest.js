// weather/ingest.js
// Pulls the farm's Ecowitt station history, aggregates it into one row per day, computes reference
// evapotranspiration for that day, and upserts it into weather_observations. Run from GitHub
// Actions once a day (see .github/workflows/weather.yml).
//
// Like notify/sender.js, this deliberately does NOT reimplement the science: it requires
// planner-shared.js and calls the same et0Daily() the irrigation page would, so the ET0 stored here
// and the ET0 the app believes in can never diverge. planner-shared.js is a UMD module precisely so
// a Node consumer like this can do that.
//
// Why the job exists at all, rather than the page calling Ecowitt directly:
//   * The API keys stay in GitHub secrets. No phone ever holds them, and there is nothing to set up
//     on a new device.
//   * Ecowitt does not send CORS headers, so a browser could not call it anyway.
//   * ET0 needs daily aggregates — max and min temperature, max and min humidity, mean solar, mean
//     wind — which means walking 48 half-hourly points per day. Doing that once server-side and
//     storing the answer is cheaper than every page load redoing it.
//
// Idempotency is in Postgres: weather_observations has a unique index on ("Date","Station") and
// every write is an upsert, so re-running the job — or a backfill overlapping data already held —
// rewrites rows rather than duplicating them.

const PlannerShared = require("../planner-shared.js");

const { CFG, AT_ID_TO_PG, et0Daily, irDateToISO, irAddDays } = PlannerShared;

const SB_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SB_SERVICE_KEY = requireEnv("SUPABASE_SERVICE_KEY");
const EC_APP_KEY = requireEnv("ECOWITT_APPLICATION_KEY");
const EC_API_KEY = requireEnv("ECOWITT_API_KEY");
const EC_MAC = requireEnv("ECOWITT_MAC");

// The station reports in farm-local time and the balance is walked in farm-local days, so the whole
// job works in Australia/Sydney. A UTC day boundary would put a hot afternoon and the following
// cool morning in the same "day" for half the year and quietly skew every Tmax/Tmin.
const TZ = "Australia/Sydney";

// Site constants for ET0. These also live in irrigation_settings, which is the authority — these
// are only the fallback for the first run, before anyone has opened the settings card.
const SITE_FALLBACK = {
  lat: PlannerShared.IRRIG_DEFAULTS.lat,
  elev: PlannerShared.IRRIG_DEFAULTS.elev,
  anemHeight: PlannerShared.IRRIG_DEFAULTS.anemHeight,
};

// How many days back to fetch on an ordinary run. Two, not one: a station that was offline
// yesterday will have backfilled its own gap to the Ecowitt cloud by now, and re-reading the day
// before is how that gap gets picked up without anyone noticing it existed.
const DEFAULT_BACKFILL_DAYS = 2;

// Ecowitt caps a 30-minute-resolution history query at roughly a week. Ask for less than the cap so
// a boundary change on their side doesn't turn a backfill into a silent partial.
const WINDOW_DAYS = 6;
const PAUSE_MS = 1100;   // between calls, to stay well inside the published rate limit

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- local time ---------- */

// Today's date at the farm, as YYYY-MM-DD. en-CA because it formats as ISO.
function farmToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/* ---------- Supabase ---------- */

function sbHeaders(extra = {}) {
  return {
    apikey: SB_SERVICE_KEY,
    Authorization: `Bearer ${SB_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function sbToRecord(row) {
  const { id, ...fields } = row;
  return { id, fields };
}

async function sbFetchAll(airtableTableId, query = "select=*&order=id") {
  const pgTable = AT_ID_TO_PG[airtableTableId];
  if (!pgTable) throw new Error(`No Postgres table mapped for ${airtableTableId}`);
  const r = await fetch(`${SB_URL}/rest/v1/${pgTable}?${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`${pgTable} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()).map(sbToRecord);
}

// Upsert on the ("Date","Station") unique index. merge-duplicates is what makes a re-run harmless.
async function sbUpsertObservations(rows) {
  if (!rows.length) return;
  const pgTable = AT_ID_TO_PG[CFG.tables.weatherObs];
  const r = await fetch(`${SB_URL}/rest/v1/${pgTable}?on_conflict=%22Date%22,%22Station%22`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    throw new Error(`upsert weather_observations ${r.status}: ${(await r.text().catch(() => "")).slice(0, 400)}`);
  }
}

/* ---------- Ecowitt ---------- */

// Unit ids are set explicitly on every call and that is not optional. Leave them off and the
// account's dashboard preference decides whether you get Fahrenheit and mph — which produces an
// ET0 that is wrong by a factor rather than an error, so nothing looks broken and every run time
// downstream is quietly nonsense.
const EC_UNITS = {
  temp_unitid: 1,               // Celsius
  pressure_unitid: 3,           // hPa
  wind_speed_unitid: 6,         // m/s
  rainfall_unitid: 12,          // mm
  solar_irradiance_unitid: 16,  // W/m^2
};

async function ecowittHistory(startISO, endISO) {
  const params = new URLSearchParams({
    application_key: EC_APP_KEY,
    api_key: EC_API_KEY,
    mac: EC_MAC,
    start_date: `${startISO} 00:00:00`,
    end_date: `${endISO} 23:59:59`,
    // 30-minute resolution, not daily. `cycle_type=1day` returns values Ecowitt has already
    // averaged, which destroys the daily extremes — and Tmax/Tmin are load-bearing in both the
    // vapour-pressure and the long-wave-radiation terms of Penman-Monteith.
    cycle_type: "30min",
    call_back: "outdoor,solar_and_uvi,wind,rainfall",
    ...Object.fromEntries(Object.entries(EC_UNITS).map(([k, v]) => [k, String(v)])),
  });
  const url = `https://api.ecowitt.net/api/v3/device/history?${params}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Ecowitt history ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const j = await r.json();
  // Ecowitt returns HTTP 200 with a non-zero code in the body for auth and quota failures, so the
  // status line alone is not evidence the call worked.
  if (j.code !== 0) throw new Error(`Ecowitt API code ${j.code}: ${j.msg || "unknown"}`);
  return j.data || {};
}

// The payload nests as data.<group>.<field>.list = { "<unix seconds>": "<value>" }. Pull one such
// series out as [{ts, val}], dropping anything non-numeric — the station emits "-" for a sensor
// that did not report, and a NaN sliding into a mean would poison a whole day.
function series(data, group, field) {
  const list = data && data[group] && data[group][field] && data[group][field].list;
  if (!list) return [];
  return Object.keys(list).map(k => {
    const v = parseFloat(list[k]);
    return { ts: parseInt(k, 10) * 1000, val: Number.isFinite(v) ? v : null };
  }).filter(p => p.val !== null && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
}

// Which farm-local day a reading belongs to.
function dayOf(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}

function groupByDay(points) {
  const out = {};
  points.forEach(p => { (out[dayOf(p.ts)] ||= []).push(p.val); });
  return out;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const max  = a => a.length ? Math.max(...a) : null;
const min  = a => a.length ? Math.min(...a) : null;

/* ---------- aggregation ---------- */

// Turn a history payload into one record per day.
function aggregate(data, site) {
  const temp   = groupByDay(series(data, "outdoor", "temperature"));
  const hum    = groupByDay(series(data, "outdoor", "humidity"));
  const wind   = groupByDay(series(data, "wind", "wind_speed"));
  const gust   = groupByDay(series(data, "wind", "wind_gust"));
  const solar  = groupByDay(series(data, "solar_and_uvi", "solar"));
  // Rain arrives as running counters, not per-interval amounts. The daily counter is the one to
  // read; the yearly counter is kept as a cross-check because the daily one resets at whatever hour
  // the station is configured for, which is not necessarily midnight.
  const rainD  = groupByDay(series(data, "rainfall", "daily"));
  const rainY  = groupByDay(series(data, "rainfall", "yearly"));

  const days = [...new Set([...Object.keys(temp), ...Object.keys(rainD)])].sort();
  const yearlyEnd = {};
  Object.keys(rainY).forEach(d => { yearlyEnd[d] = max(rainY[d]); });

  return days.map(date => {
    const t = temp[date] || [], h = hum[date] || [], s = solar[date] || [];
    const points = t.length;

    const tmax = max(t), tmin = min(t);
    const solarW = mean(s);
    // Mean W/m^2 over the whole 24 h -> MJ/m^2/day. The station reports 0 overnight, so as long as
    // the day's points span it, this is the honest daily integral.
    const solarMJ = solarW == null ? null : solarW * 86400 / 1e6;

    // Rain: the highest reading of the daily counter is the day's total.
    let rain = max(rainD[date] || []);
    // Cross-check against the change in the yearly counter across the day. They should agree; when
    // they don't by more than a millimetre the reset hour is probably not midnight, and that is
    // worth knowing rather than silently averaging away.
    const prev = irAddDays(date, -1);
    let rainCheck = null;
    if (yearlyEnd[date] != null && yearlyEnd[prev] != null) {
      rainCheck = Math.round((yearlyEnd[date] - yearlyEnd[prev]) * 100) / 100;
    }

    const et0r = et0Daily({
      date, tmax, tmin,
      rhMax: max(h), rhMin: min(h), rhMean: mean(h),
      wind: mean(wind[date] || []),
      solarMJ,
    }, site);

    const warnCodes = et0r.warnings.map(w => w.code);
    if (rainCheck != null && rain != null && Math.abs(rainCheck - rain) > 1) {
      warnCodes.push("rain_counters_disagree");
    }
    if (points < 24) warnCodes.push("sparse_day");   // fewer than half the expected 48 readings

    return {
      "Date": date,
      "Station": EC_MAC,
      "Temp max C": round(tmax, 2),
      "Temp min C": round(tmin, 2),
      "RH max pct": round(max(h), 1),
      "RH min pct": round(min(h), 1),
      "RH mean pct": round(mean(h), 1),
      "Wind mean m/s": round(mean(wind[date] || []), 3),
      "Wind gust max m/s": round(max(gust[date] || []), 2),
      "Solar mean W/m2": round(solarW, 2),
      "Solar MJ/m2": round(solarMJ, 3),
      "Rain mm": round(rain, 2),
      "ET0 mm": round(et0r.et0, 3),
      "Method": et0r.method,
      "Points": points,
      // Everything needed to argue with the ET0 later without going back to Ecowitt for data that
      // may by then have aged out of their retention.
      "Raw": {
        rainDailyCounterMax: round(rain, 2),
        rainYearlyDelta: rainCheck,
        et0: { Ra: round(et0r.Ra, 3), Rs: round(et0r.Rs, 3), Rn: round(et0r.Rn, 3),
               es: round(et0r.es, 4), ea: round(et0r.ea, 4), u2: round(et0r.u2, 3) },
        warnings: warnCodes,
        site,
      },
      "Created at": new Date().toISOString(),
    };
  });
}

function round(v, dp) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/* ---------- main ---------- */

async function main() {
  const backfillDays = Math.max(1, parseInt(process.env.BACKFILL_DAYS || "", 10) || DEFAULT_BACKFILL_DAYS);
  const dryRun = String(process.env.DRY_RUN || "").toLowerCase() === "true";

  // Site constants come from irrigation_settings when the table is reachable. It may not be — the
  // SQL might not have been run yet — and a weather job that refuses to run because a settings row
  // is missing would be a silly way to lose a day of data.
  let site = { ...SITE_FALLBACK };
  try {
    const rows = await sbFetchAll(CFG.tables.irrigSettings, "select=*&limit=1");
    const s = PlannerShared.parseIrrigSettings(rows);
    site = { lat: s.lat, elev: s.elev, anemHeight: s.anemHeight };
  } catch (e) {
    console.warn("irrigation_settings unreadable, using fallback site constants:", e.message);
  }
  console.log(`site: lat ${site.lat}, elev ${site.elev} m, anemometer ${site.anemHeight} m`);

  // Yesterday backwards. Today is deliberately excluded: a part-day would give a Tmax that has not
  // happened yet and a rain total that is still rising, and storing it would put a wrong ET0 on the
  // record that tomorrow's run has no reason to revisit.
  const today = farmToday();
  const endISO = irAddDays(today, -1);
  const startISO = irAddDays(endISO, -(backfillDays - 1));
  console.log(`fetching ${startISO} .. ${endISO} (${backfillDays} day${backfillDays === 1 ? "" : "s"})`);

  let rows = [];
  let cursor = startISO;
  while (cursor <= endISO) {
    let windowEnd = irAddDays(cursor, WINDOW_DAYS - 1);
    if (windowEnd > endISO) windowEnd = endISO;
    // One day of lead-in, so the yearly-counter cross-check has a previous day to difference
    // against at the start of each window.
    const fetchFrom = irAddDays(cursor, -1);
    process.stdout.write(`  ${cursor} .. ${windowEnd} `);
    const data = await ecowittHistory(fetchFrom, windowEnd);
    const agg = aggregate(data, site).filter(r => r["Date"] >= cursor && r["Date"] <= windowEnd);
    console.log(`-> ${agg.length} day(s)`);
    rows = rows.concat(agg);
    cursor = irAddDays(windowEnd, 1);
    if (cursor <= endISO) await sleep(PAUSE_MS);
  }

  if (!rows.length) {
    console.log("no days returned — nothing to write");
    return;
  }

  rows.forEach(r => {
    const w = (r["Raw"].warnings || []);
    console.log(
      `  ${r["Date"]}  ET0 ${String(r["ET0 mm"] ?? "—").padStart(6)} mm (${r["Method"]})` +
      `  rain ${String(r["Rain mm"] ?? "—").padStart(6)} mm` +
      `  T ${r["Temp min C"]}–${r["Temp max C"]}°C  n=${r["Points"]}` +
      (w.length ? `  [${w.join(",")}]` : "")
    );
  });

  if (dryRun) { console.log("DRY_RUN set — not writing"); return; }

  // In chunks, so one oversized backfill doesn't hit a request size limit.
  for (let i = 0; i < rows.length; i += 200) {
    await sbUpsertObservations(rows.slice(i, i + 200));
  }
  console.log(`upserted ${rows.length} day(s) into weather_observations`);
}

main().catch(e => { console.error(e); process.exit(1); });
