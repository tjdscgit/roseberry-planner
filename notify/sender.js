// notify/sender.js
// Decides what's worth a push notification right now, and sends it. Run from GitHub Actions every
// 15 minutes (see .github/workflows/notify.yml).
//
// The whole point of this file is that it does NOT reimplement "what's due" — it requires
// planner-shared.js and calls the same wkCollect() the app uses, so the notification and the week
// view can't disagree about what's on today. planner-shared.js is a UMD module specifically so a
// Node consumer like this one can do that.
//
// Two kinds of notification:
//   digest — one a day, around 06:00 local, listing everything due today.
//   task   — a ping at a *pinned* task's own clock time. Only tasks deliberately dragged to a time
//            in the week view have one (pt_start); everything else is auto-packed for display only
//            and its "time" is meaningless, so it is never used as a reminder time.
//
// Idempotency lives in Postgres, not here: every send inserts into notification_sends first, and a
// unique-constraint violation means "already sent" and the send is skipped. That is what makes a
// job that runs 96 times a day safe.

const webpush = require("web-push");
const PlannerShared = require("../planner-shared.js");

const { CFG, AT_ID_TO_PG } = PlannerShared;

const SB_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SB_SERVICE_KEY = requireEnv("SUPABASE_SERVICE_KEY");
const VAPID_PUBLIC = requireEnv("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE = requireEnv("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:gday@roseberrygrowers.com.au";

// The farm is in NSW. Deriving local time from a named zone rather than a fixed offset is what
// keeps the 6am digest at 6am across the daylight-saving changeover without any dated fudging.
const TZ = "Australia/Sydney";

const DIGEST_HOUR = 6;
// A pinned task fires on the first run at or after its time, but never more than this far late —
// otherwise a morning of failed runs would deliver a 7am reminder at dusk, which is worse than
// silence because it reads as current.
const TASK_LATE_GRACE_MIN = 120;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

// web-push validates the keys here and throws a stack trace pointing into its own internals, which
// is a confusing way to find out you pasted the wrong thing into a GitHub secret. Check the shape
// first and fail with something that names the secret and says what it should look like.
function checkVapidKey(name, value, expectedLength) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      `${name} is not URL-safe base64. It looks like the wrong value went into the GitHub secret ` +
      `(a command, a quoted string, or something with padding). Expected ${expectedLength} characters ` +
      `of [A-Za-z0-9_-]; got ${value.length}.`
    );
  }
  if (value.length !== expectedLength) {
    throw new Error(`${name} should be ${expectedLength} characters, got ${value.length}.`);
  }
}

checkVapidKey("VAPID_PUBLIC_KEY", VAPID_PUBLIC, 87);
checkVapidKey("VAPID_PRIVATE_KEY", VAPID_PRIVATE, 43);
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

/* ---------- Supabase ---------- */

function sbHeaders(extra = {}) {
  return {
    apikey: SB_SERVICE_KEY,
    Authorization: `Bearer ${SB_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Mirrors the app's sbToRecord: Postgres columns carry the Airtable field names, so handing the
// row to a PlannerShared parser only needs the id lifted out.
function sbToRecord(row) {
  const { id, ...fields } = row;
  return { id, fields };
}

async function sbFetchAll(airtableTableId) {
  const pgTable = AT_ID_TO_PG[airtableTableId];
  if (!pgTable) throw new Error(`No Postgres table mapped for ${airtableTableId}`);
  const pageSize = 1000;
  let all = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = `${SB_URL}/rest/v1/${pgTable}?select=*&order=id&offset=${offset}&limit=${pageSize}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`${pgTable} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    const page = await r.json();
    all = all.concat(page.map(sbToRecord));
    if (page.length < pageSize) return all;
  }
}

/* ---------- local time ---------- */

// Intl gives the wall-clock reading in TZ for an instant; that's all the scheduling needs, and it
// is DST-correct by construction.
function localParts(now) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return {
    dateISO: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    get minutesOfDay() { return this.hour * 60 + this.minute; },
  };
}

/* ---------- what's due ---------- */

async function loadWeek(nowLocalISO) {
  // Only the tables wkCollect actually reads. Pulling the whole base would work but this job runs
  // 96 times a day; there's no reason to drag the spray and fert history through it every time.
  // wkCollect also derives jobs from tarps (lay/pull) and Planned sprays, so those tables have to
  // be here too — leaving them out wouldn't error, it would just quietly omit real work from the
  // digest, which is the worse failure.
  const [plantingTaskRecs, plantingRecs, taskRecs, cropRecs, bedRecs, cropTaskRecs, tarpRecs, sprayRecs] =
    await Promise.all([
      sbFetchAll(CFG.tables.plantingTasks),
      sbFetchAll(CFG.tables.plantings),
      sbFetchAll(CFG.tables.tasks),
      sbFetchAll(CFG.tables.crops),
      sbFetchAll(CFG.tables.beds),
      sbFetchAll(CFG.tables.cropTasks),
      sbFetchAll(CFG.tables.tarpings),
      sbFetchAll(CFG.tables.sprayApplications),
    ]);

  // Order matters: parsePlantings resolves each planting's crop name through this map, so the
  // crops have to be parsed first.
  const { crops } = PlannerShared.parseCropsAndDefs(cropRecs);
  const data = {
    plantingTasks: plantingTaskRecs.map(PlannerShared.parsePlantingTaskRecord),
    plantings: PlannerShared.parsePlantings(plantingRecs, crops),
    tasks: PlannerShared.parseTasks(taskRecs),
    cropTasks: cropTaskRecs.map(r => ({ id: r.id, ...r.fields })),
    beds: PlannerShared.parseBeds(bedRecs),
    tarps: PlannerShared.parseTarpings(tarpRecs),
    sprayApplications: PlannerShared.parseSprayApplications(sprayRecs),
    crops,
  };

  const monday = PlannerShared.wkISO(PlannerShared.wkMonday(PlannerShared.wkParse(nowLocalISO)));
  // wkCollect returns {rows, start}, not a bare array.
  const { rows } = PlannerShared.wkCollect(data, monday, PlannerShared.wkParse(nowLocalISO));
  return { rows, data };
}

// "Foliar feed · Tomatoes · B4" — enough to act on without opening the app.
// bedNameOf takes the planting (it reads p.bedIds[0] itself), not a bed id.
function describeRow(row, data) {
  const name = (row.task && row.task.name) || "Task";
  const crop = row.p && row.p.crop ? row.p.crop : "";
  const bed = (row.p && row.p.bedIds && row.p.bedIds.length)
    ? (PlannerShared.bedNameOf(data, row.p) || "")
    : "";
  return [name, crop, bed].filter(Boolean).join(" · ");
}

/* ---------- idempotency ---------- */

// Insert-first: if this row already exists the unique constraint rejects it and we know the
// notification has already gone out. Doing it in this order means a crash between claiming and
// sending loses a notification rather than duplicating one, which is the safer way to fail.
async function claimSend(kind, refId, dateISO) {
  const r = await fetch(`${SB_URL}/rest/v1/notification_sends`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ kind, ref_id: refId, sent_for_date: dateISO }),
  });
  if (r.status === 409) return false;          // unique violation → already sent
  if (!r.ok) throw new Error(`claim ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return true;
}

/* ---------- widget snapshot ---------- */

// Written every run so the Android home-screen widget and Quick Settings tile have something to
// read. Deliberately reuses `todays`/`overdue` as already computed for the push digest rather than
// re-deriving "what's due" a third time — see the file header.
// A row's clock time is its *pinned* Start minute (t.start) -- the same field the task-ping
// section below reads. Unpinned tasks are auto-packed for display only, so they get no time here.
function rowTime(r) {
  const start = r.t && r.t.start;
  if (start == null) return null;
  const hh = String(Math.floor(start / 60)).padStart(2, "0");
  const mm = String(start % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function writeWidgetSnapshot(todays, overdue, data) {
  const items = todays
    .slice(0, 5)
    .map(r => ({ task: describeRow(r, data) || "Task", time: rowTime(r), overdue: false }))
    .concat(
      overdue.length && !todays.length
        ? overdue.slice(0, 5).map(r => ({ task: describeRow(r, data) || "Task", time: rowTime(r), overdue: true }))
        : []
    );
  const r = await fetch(`${SB_URL}/rest/v1/widget_snapshot?id=eq.1`, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ updated_at: new Date().toISOString(), count: todays.length, items }),
  });
  if (!r.ok) {
    // Never let a snapshot-write failure take down the actual notification send.
    console.error(`widget snapshot ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  }
}

/* ---------- sending ---------- */

async function loadSubscriptions() {
  const r = await fetch(`${SB_URL}/rest/v1/push_subscriptions?select=*`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`subscriptions ${r.status}`);
  return r.json();
}

async function dropSubscription(id) {
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: "DELETE",
    headers: sbHeaders({ Prefer: "return=minimal" }),
  }).catch(() => {});
}

async function sendToAll(subs, payload) {
  let sent = 0;
  for (const s of subs) {
    const who = `${s.label || "device"} ${s.id.slice(0, 8)}`;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
      console.log(`  ✓ sent to ${who}`);
    } catch (e) {
      const code = e.statusCode || "?";
      // 404/410 mean the push service considers the registration gone (app uninstalled, data
      // cleared, endpoint rotated). Those are permanent, so prune rather than retrying them 96
      // times a day forever — but say so loudly. Pruning quietly is how you end up staring at a
      // green tick wondering why no notification arrived.
      if (code === 404 || code === 410) {
        console.error(`  ✗ ${who}: push service says the subscription is gone (${code}). ` +
                      `Removing it — re-enable notifications on that device to register again.`);
        await dropSubscription(s.id);
      } else if (code === 403) {
        // Signed with a keypair the subscription wasn't created against.
        console.error(`  ✗ ${who}: rejected (403). The VAPID keys used to send don't match the ` +
                      `ones the device subscribed with. Keeping the subscription.`);
      } else {
        console.error(`  ✗ ${who}: send failed (${code}): ${e.message}`);
      }
    }
  }
  return sent;
}

/* ---------- main ---------- */

async function main() {
  const now = new Date();
  const local = localParts(now);
  const nowMin = local.minutesOfDay;

  const subs = await loadSubscriptions();
  if (!subs.length) { console.log("No subscriptions registered; nothing to do."); return; }
  console.log(`${subs.length} device(s) registered: ${subs.map(s => s.label || "?").join(", ")}`);

  // Fired by hand from the Actions tab ("Run workflow" with test ticked). Sends one notification
  // unconditionally so delivery can be proved on a real phone without waiting for 6am or pinning a
  // task to the next few minutes. Deliberately skips the idempotency ledger — a test you can only
  // run once a day would be useless.
  if (process.env.TEST_NOTIFICATION === "true") {
    const n = await sendToAll(subs, {
      title: "Roseberry Planner",
      body: `Test notification — ${local.dateISO} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}. Reminders are working.`,
      tag: "test",
      url: "./roseberry-planner.html",
    });
    console.log(`test → ${n} device(s)`);
    return;
  }

  const { rows, data } = await loadWeek(local.dateISO);
  const todays = rows.filter(r => !r.t.done && PlannerShared.wkSameDay(r.due, PlannerShared.wkParse(local.dateISO)));
  const overdue = rows.filter(r => r.overdue && !r.t.done);

  await writeWidgetSnapshot(todays, overdue, data);

  // --- the morning digest ---
  if (local.hour === DIGEST_HOUR && await claimSend("digest", null, local.dateISO)) {
    const lines = todays.slice(0, 6).map(r => describeRow(r, data)).filter(Boolean);
    const extra = todays.length > lines.length ? ` +${todays.length - lines.length} more` : "";
    const body = todays.length
      ? lines.join("\n") + extra
      : (overdue.length ? "Nothing due today." : "Nothing due today. All clear.");
    const title = todays.length
      ? `${todays.length} due today${overdue.length ? `, ${overdue.length} overdue` : ""}`
      : (overdue.length ? `${overdue.length} overdue` : "Nothing due today");

    const n = await sendToAll(subs, { title, body, tag: "digest", url: "./roseberry-planner.html" });
    console.log(`digest → ${n} device(s): ${title}`);
  }

  // --- pinned-time task pings ---
  for (const r of todays) {
    const start = r.t && r.t.start;
    if (start == null) continue;                       // not pinned to a time → digest only
    if (nowMin < start) continue;                      // not yet
    if (nowMin - start > TASK_LATE_GRACE_MIN) continue; // too late to be useful
    if (!(await claimSend("task", String(r.id), local.dateISO))) continue;

    const hh = String(Math.floor(start / 60)).padStart(2, "0");
    const mm = String(start % 60).padStart(2, "0");
    const n = await sendToAll(subs, {
      title: `${hh}:${mm} · ${(r.task && r.task.name) || "Task"}`,
      body: describeRow(r, data) || "Due now.",
      tag: `task:${r.id}`,
      url: "./roseberry-planner.html",
    });
    console.log(`task ${r.id} → ${n} device(s)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
