// planner-shared.js
// Shared data model + business logic between roseberry-planner.html (browser, classic <script>,
// window.PlannerShared) and any Node-side consumer (CommonJS require, module.exports) — e.g. an
// MCP server. Keeping this in one file means the "what counts as this week / overdue" rule and
// the milestone-status stepper rule can't silently diverge between the app and anything else that
// reads/writes the same Airtable base.
//
// Deliberately NOT included here (kept in roseberry-planner.html only, since they're DOM/UI
// concerns, not data/business rules): rendering, drag-and-drop, dialogs, the farm/crop map layout,
// UI state persistence. The Airtable CRUD wrapper (atFetch/atPatch/atCreate/atDelete) is also kept
// duplicated rather than shared — it's generic HTTP boilerplate with no business rule inside it,
// and the browser side needs it closed over a mutable, re-enterable `PAT` global that a shared
// factory would only complicate.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlannerShared = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CFG = {
    farmBase: "appkAem0klgcen8X2",
    planBase: "applc11x0y6F4CTdx",
    tables: {
      blocks:    "tblhf95DwXV9TkUw0",
      beds:      "tbl6hWfUDGKx3i7Tx",   // "Location"
      plantings: "tblCKqtYSJ79Ugs7j",
      crops:     "tblNrC1WTS6Z4cIeZ",
      varieties: "tblVJfY6CMoGA3TOf",   // "Crop Varieties" — variety-level overrides of the Crop defaults
      trayTypes: "tblBtWkrGPsw1N4Hc",   // "Tray Types" — farm-wide tray name -> cell count list (Misc tab)
      tasks:     "tbliAKSvDB8ToYDTC",   // "Tasks" — master library of cultural tasks + default schedule
      cropTasks: "tblFH4TyHWlwBKtUY",   // "Crop Tasks" — assigns a task to a crop/variety, overriding the default
      plantingTasks: "tblah0KRCPdFK3BPv", // "Planting Tasks" — dated task instances for one planting (Add-planting dialog's Tasks tab)
      salesOutlets:  "tblzQhATkdpOGbpBh", // "Sales Outlets" — where produce is sold (Harvest → Sales outlets page)
      harvestRecords:"tblmh2KDsRkgWnA70", // "Harvest Records" — planned/actual harvest per planting × outlet × week (Harvest planner)
      tarpings:  "tblMiHkcM5GM68J2R", // "Tarpings" — a bed-and-date-range tarp used as crop termination; optionally linked to the planting it terminates
      bedIssues: "tbl3z7PMcqLruxGFF", // "Bed Issues" — persistent problems with a bed (nutrition, weeds, disease) that flag, but never block, a matching crop
      // Spray log (Fert & Foliar base). The app-native replacement for the old wide Spray Data /
      // Ferti Data entry form. Products is the shared catalog; Mixes are saved recipes; Applications
      // are the actual log. Mix Items / Application Items are the product-and-rate lines of each.
      sprayProducts:     "tblFO5bRfGA4n7Pxc", // "Spray Products"
      sprayMixes:        "tblMYw5eg9lW7cyMF", // "Spray Mixes"
      sprayMixItems:     "tblodwnFCwjbYatej", // "Spray Mix Items"
      sprayApplications: "tblRjipt1eRDu1sZ9", // "Spray Applications"
      sprayApplicationItems: "tblHq9TVFc5zQDwnc", // "Spray Application Items"
    },
    f: { // field names (readable; rename in Airtable => update here)
      blk_name:"Name", blk_x:"Map X", blk_y:"Map Y", blk_orient:"Orientation", blk_prefTypes:"Preferred Crop Types",
      bed_name:"Bed", bed_block:"Block", bed_len:"Length m", bed_wid:"Width m", bed_order:"Order in block",
      bed_category:"Bed category", bed_tunnel:"Under tunnel", bed_notes:"Bed notes",
      // Bed Issues — what's wrong with a bed and which crops that rules out. `bi_types` is the
      // rotation family (matches Crop.Type), `bi_crops` names individual crops; an issue with both
      // empty is a note on the bed and flags nothing. Blank from/until = unbounded on that side.
      bi_name:"Name", bi_bed:"Bed", bi_type:"Issue type", bi_severity:"Severity",
      bi_types:"Excluded crop types", bi_crops:"Excluded crops",
      bi_from:"Active from", bi_until:"Active until", bi_notes:"Notes",
      tt_name:"Name", tt_cells:"Cell count",
      tk_name:"Name", tk_cat:"Category", tk_desc:"Description",
      tk_anchor:"Anchor", tk_offset:"Offset days", tk_repeat:"Repeat every (days)", tk_until:"Repeat until",
      tk_duration:"Minutes per 15m bed",
      ct_label:"Label", ct_task:"Task", ct_crop:"Crop", ct_variety:"Variety",
      ct_anchor:"Anchor", ct_offset:"Offset days", ct_repeat:"Repeat every (days)", ct_until:"Repeat until",
      ct_duration:"Minutes per 15m bed",
      pt_label:"Label", pt_planting:"Planting", pt_task:"Task", pt_anchor:"Anchor", pt_offset:"Offset days",
      pt_due:"Due date", pt_done:"Done", pt_start:"Start minute",
      pt_repeat:"Repeat every (days)", pt_until:"Repeat until", pt_duration:"Minutes per 15m bed",
      pt_assignee:"Assignee", pt_ttid:"TickTick Task ID", pt_gcalid:"Google Cal Event ID",
      pt_bed:"Bed",   // optional bed a task attaches to when it isn't tied to a planting
      pl_crop:"Crop", pl_bed:"Bed", pl_var:"Variety", pl_status:"Status", pl_bm:"Bed metres", pl_notes:"Notes",
      pl_sow:"Sow date", pl_tp:"Transplant date", pl_h1:"First harvest", pl_h2:"Last harvest",
      pl_sowTtId:"Sow TickTick Task ID", pl_tpTtId:"Transplant TickTick Task ID",
      pl_sowGcalId:"Sow Google Cal Event ID", pl_tpGcalId:"Transplant Google Cal Event ID",
      pl_group:"Succession group",
      pl_sowStart:"Sow start minute", pl_tpStart:"Transplant start minute",
      pl_sowAssignee:"Sow assignee", pl_tpAssignee:"Transplant assignee",
      pl_h1Assignee:"First harvest assignee", pl_h2Assignee:"Last harvest assignee",
      pl_rows:"Number of rows", pl_rowSpacing:"Spacing between rows cm", pl_plantSpacing:"In-row spacing cm",
      pl_seeder:"Seeder type", pl_harvestUnit:"Harvest unit", pl_plantsPerUnit:"Plants per unit",
      pl_price:"Price", pl_yield:"Yield per bed metre",
      pl_trayType:"Tray type", pl_seedsPerCell:"Seeds per cell", pl_daysToGerminate:"Days to germinate",
      pl_germTemp:"Optimal germ temp (°C)", pl_pottingUp:"Requires potting up",
      // Written by the Seed book page from a photo of the paper seeding book. `pl_sowActual` is
      // deliberately NOT `pl_sow`: Sow date is the plan every task date anchors to, so the book
      // records what really happened beside it rather than silently reshuffling the schedule.
      // `pl_tpActual` is the same idea for the transplant step — both are also auto-stamped by
      // the milestone-tick stepper (see buildMilestonePatch below) and hand-editable in the
      // Add/Edit Planting dialog.
      pl_seedRef:"Seed ref", pl_traysSown:"Trays sown", pl_sowActual:"Actual sow date",
      pl_tpActual:"Actual transplant date",
      cr_type:"Type",
      cr_method:"Method", cr_nursery:"Days in nursery", cr_dtm:"Days to maturity",
      cr_window:"Harvest window days", cr_gap:"Succession interval days",
      cr_rows:"Rows per bed", cr_rowSpacing:"Spacing between rows cm", cr_plantSpacing:"In-row spacing cm",
      cr_seeder:"Seeder type", cr_harvestUnit:"Harvest unit", cr_plantsPerUnit:"Plants per unit",
      cr_price:"Price", cr_yield:"Yield per bed metre",
      cr_trayType:"Tray type", cr_seedsPerCell:"Seeds per cell", cr_daysToGerminate:"Days to germinate",
      cr_germTemp:"Optimal germ temp (°C)", cr_pottingUp:"Requires potting up",
      va_name:"Variety", va_crop:"Crop", va_method:"Method", va_nursery:"Days in nursery",
      va_dtm:"Days to maturity", va_window:"Harvest window days", va_gap:"Succession interval days",
      va_rows:"Rows per bed", va_rowSpacing:"Spacing between rows cm", va_plantSpacing:"In-row spacing cm",
      va_seeder:"Seeder type", va_harvestUnit:"Harvest unit", va_plantsPerUnit:"Plants per unit",
      va_price:"Price", va_yield:"Yield per bed metre",
      va_trayType:"Tray type", va_seedsPerCell:"Seeds per cell", va_daysToGerminate:"Days to germinate",
      va_germTemp:"Optimal germ temp (°C)", va_pottingUp:"Requires potting up",
      so_name:"Name", so_type:"Type", so_active:"Active", so_notes:"Notes", so_order:"Order",
      hr_name:"Name", hr_planting:"Planting", hr_outlet:"Sales Outlet", hr_week:"Week starting",
      hr_planned:"Planned", hr_actual:"Actual", hr_priceOverride:"Price override", hr_notes:"Notes",
      // Tarping — a bed covered for a stretch to kill off crop residue. `tr_planting` is optional:
      // set, it's the termination of that crop; blank, it's a standalone bed tarping. `tr_laidActual`
      // / `tr_pulledActual` sit beside the planned dates rather than replacing them, same reasoning
      // as pl_sowActual above. Note the prefix is `tr_`, not `tp_` — `tp` already means transplant.
      tr_name:"Name", tr_bed:"Bed", tr_planting:"Planting",
      tr_start:"Start date", tr_end:"End date", tr_bm:"Bed metres", tr_status:"Status",
      tr_laidActual:"Actual laid", tr_pulledActual:"Actual pulled", tr_notes:"Notes",
      // A tarp has TWO jobs (lay + pull), so every per-job field is doubled — same shape as
      // Plantings carrying separate Sow…/Transplant… columns for its two milestones. TARP_STEPS
      // below maps each step to its own set, so nothing else has to branch on lay-vs-pull.
      tr_layAssignee:"Lay assignee", tr_pullAssignee:"Pull assignee",
      tr_layStart:"Lay start minute", tr_pullStart:"Pull start minute",
      tr_layTtId:"Lay TickTick Task ID", tr_pullTtId:"Pull TickTick Task ID",
      tr_layGcalId:"Lay Google Cal Event ID", tr_pullGcalId:"Pull Google Cal Event ID",
      // Spray Products (catalog). `spp_whp` is the per-product withholding period; an application's
      // WHP is the max across its products (see mixWhp below).
      spp_name:"Name", spp_cat:"Category", spp_unit:"Unit", spp_rate:"Default rate",
      spp_basis:"Rate basis", spp_whp:"WHP days", spp_organic:"Organic status",
      spp_active:"Active", spp_notes:"Notes",
      // Spray Mixes (saved recipes) + their ingredient lines.
      smx_name:"Name", smx_target:"Target / reason", smx_water:"Water volume", smx_waterBasis:"Water basis",
      smx_method:"Method notes", smx_whp:"WHP days", smx_fav:"Favourite", smx_active:"Active",
      smi_name:"Name", smi_mix:"Mix", smi_product:"Product", smi_rate:"Rate", smi_unit:"Unit", smi_order:"Order",
      // Spray Applications (the log) + their product lines. `sap_beds`/`sap_crops` reuse the same
      // Location/Crop tables the planner already links, so map selection and migration link by id.
      sap_name:"Name", sap_date:"Date", sap_by:"Sprayed by", sap_beds:"Beds", sap_crops:"Crops",
      sap_locNote:"Location note", sap_fromMix:"From mix", sap_method:"Application method",
      sap_amount:"Amount sprayed", sap_amountUnit:"Amount unit", sap_reason:"Reason / target",
      sap_whp:"WHP days", sap_photos:"Photos", sap_notes:"Notes", sap_legacy:"Legacy ref",
      // Status: "Planned" (a scheduled spray, shown as a task in the weekly planner) vs "Logged"
      // (actually applied). Blank ⇒ Logged. `sap_followUp` links a scheduled follow-up back to the
      // spray it follows.
      sap_status:"Status", sap_followUp:"Follow-up of",
      sai_name:"Name", sai_app:"Application", sai_product:"Product", sai_rate:"Rate",
      sai_unit:"Unit", sai_amountUsed:"Amount used", sai_order:"Order",
    }
  };

  const num = v => (v===undefined||v===null||v==="")?null:(+v);

  // fields shared identically by Crop, Crop Varieties and Plantings — see roseberry-planner.html
  // for the long-form rationale (kept only in one place here, not re-explained per call site).
  const DEFAULT_KEYS = ["method","nursery","dtm","window","gap","rows","rowSpacing","plantSpacing","seeder","harvestUnit","plantsPerUnit","price","yield","trayType","seedsPerCell","daysToGerminate","germTemp","pottingUp"];
  const SELECT_DEFAULT_KEYS = new Set(["method","seeder","harvestUnit","trayType","pottingUp"]);
  const PLANTING_DEFAULT_KEYS = ["rows","rowSpacing","plantSpacing","seeder","harvestUnit","plantsPerUnit","price","yield","trayType","seedsPerCell","daysToGerminate","germTemp","pottingUp"];

  function readDefaultFields(fields, prefix, keys){
    const out={};
    (keys||DEFAULT_KEYS).forEach(k=>{
      const fieldName = CFG.f[prefix+"_"+k];
      const raw = fields[fieldName];
      out[k] = SELECT_DEFAULT_KEYS.has(k) ? (raw||"") : num(raw);
    });
    return out;
  }

  const STATUS_ORDER=["Planned","Seeded","In ground","Harvesting","Finished"];
  function statusRank(s){ const i=STATUS_ORDER.indexOf(s); return i<0?0:i; }

  // A new planting starts "Planned"; each ticked task moves it one stage on.
  function apLifecycle(method){
    return method==="transplant"
      ? [ {label:"Sown in nursery", stage:"Seeded",     df:"sow"},
          {label:"Planted out",     stage:"In ground",  df:"tp"},
          {label:"Harvest started", stage:"Harvesting", df:"h1"},
          {label:"Finished / pulled",stage:"Finished",  df:"h2"} ]
      : [ {label:"Sown",            stage:"In ground",  df:"sow"},
          {label:"Harvest started", stage:"Harvesting", df:"h1"},
          {label:"Finished / pulled",stage:"Finished",  df:"h2"} ];
  }

  // TZ-safe local date helpers — deliberately not `new Date(isoString)` (UTC drift).
  function wkParse(s){ const [y,m,d]=String(s).split("-").map(Number); return new Date(y,(m||1)-1,d||1); }
  function wkISO(dt){ const y=dt.getFullYear(),m=String(dt.getMonth()+1).padStart(2,"0"),d=String(dt.getDate()).padStart(2,"0"); return `${y}-${m}-${d}`; }
  function wkMonday(dt){ const x=new Date(dt.getFullYear(),dt.getMonth(),dt.getDate()); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; }
  function wkAddDays(dt,n){ const x=new Date(dt); x.setDate(x.getDate()+n); return x; }
  function wkSameDay(a,b){ return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }

  function ctTaskById(data, id){ return (data.tasks||[]).find(t=>t.id===id); }
  function bedNameOf(data, p){ return (data.beds.find(x=>x.id===p.bedIds[0])||{}).name; }

  // Gather every Planting Task with a due date in the shown week, plus any still-open task
  // overdue from before it. Enriches each with its planting + library task + a minutes estimate.
  // Plus lifecycle milestones (seed/transplant) derived from each planting's own dates + Status.
  // Harvest milestones (h1/h2) are deliberately excluded (handled elsewhere, not built yet).
  // `now` is injectable (defaults to the real clock) so callers/tests can pin "today".
  //
  // A Planting Task with no linked Planting is a "manual" task (added via the weekly planner's
  // + Add task button — a one-off job, not tied to a crop/bed). Rather than threading a nullable
  // `p` through every renderer, it gets a synthetic zero-bed planting-shaped object (`crop` = its
  // own label, `bm:0` so the bed-metres-scaled minutes estimate below can't apply to it) so every
  // existing consumer of `row.p` (block rendering, By-crop&bed grouping, drag/assign/delete) keeps
  // working unchanged. `row.manual` flags it for the few call sites that DO want to tell the
  // difference (skip the redundant crop/bed context line, word the group-modal title correctly).
  function wkCollect(data, wkStartISO, now){
    now = now || new Date();
    const start=wkParse(wkStartISO), end=wkAddDays(start,7), rows=[];
    // Overdue (still-open tasks due before the window) only surface on the *current* week.
    const isCurrent=wkSameDay(start, wkMonday(now));
    (data.plantingTasks||[]).forEach(t=>{
      if(!t.due) return;
      const manual=!t.plantingId;
      let p=null;
      if(manual){
        // A manual task may still name a Bed (added via the enhanced Add-task dialog) — carry it on
        // the synthetic planting so bedNameOf() and the By-bed grouping give it real context.
        p={id:`manual:${t.id}`, crop:t.label||"Task", variety:"", bedIds:t.bedId?[t.bedId]:[], bm:0, cropId:null};
      }else{
        p=(data.plantings||[]).find(x=>x.id===t.plantingId); if(!p) return;
      }
      // A manual task that references a library Task (a library task placed on a bed, not a planting)
      // shows that task's name/category rather than the bare label.
      const libTask = t.taskId ? ctTaskById(data,t.taskId) : null;
      const task=manual
        ? (libTask ? {name:libTask.name, category:libTask.category, duration:t.duration}
                   : {name:t.label||"Task", category:"Other", duration:t.duration})
        : (ctTaskById(data,t.taskId)||{name:"(task)",category:""});
      const due=wkParse(t.due), overdue=isCurrent && !t.done && due<start, inWeek=due>=start && due<end;
      if(!overdue && !inWeek) return;
      const dur=t.duration||task.duration||0;
      // manual tasks have no bed to scale against — their duration IS the minutes estimate.
      const minutes = manual ? dur : dur*(p.bm||0)/15;
      rows.push({ id:t.id, t, p, task, due, overdue, inWeek, minutes, manual });
    });
    (data.plantings||[]).forEach(p=>{
      apLifecycle(p.tp?"transplant":"direct").forEach(step=>{
        if(step.df!=="sow" && step.df!=="tp") return;          // pre-harvest milestones only
        const dstr=p[step.df]; if(!dstr) return;               // no date set → nothing to schedule
        const due=wkParse(dstr), sr=statusRank(step.stage), cur=statusRank(p.status), done=cur>=sr;
        const overdue=isCurrent && !done && due<start, inWeek=due>=start && due<end;
        if(!overdue && !inWeek) return;
        const msName = step.df==="tp" ? "Transplant" : (p.tp ? "Sow (trays)" : "Direct sow");
        const msTask = (data.tasks||[]).find(x=>x.name===msName);
        const msMinutes = msTask && msTask.duration!=null ? msTask.duration*(p.bm||0)/15 : null;
        const msStart = step.df==="tp" ? p.tpStart : p.sowStart;
        rows.push({
          id:`ms:${p.id}:${step.df}`, kind:"milestone", msDf:step.df, msLocked:cur>sr,
          t:{done, repeat:0, start:msStart??null}, p, task:msTask||{name:msName, category:""},
          due, overdue, inWeek, minutes:msMinutes,
        });
      });
    });
    // Tarps contribute two synthetic jobs each — lay on the start date, pull on the end date.
    // Deliberately derived rather than materialised as Planting Task records: a tarp's dates move
    // whenever its planting's harvest dates move, and derived rows can't drift out of step with
    // them. Same synthetic-planting trick as the manual branch above, so every downstream renderer
    // (blocks, grouping, drag) keeps working — but with a real bed, so bedNameOf() and the
    // bed-metre-scaled minutes estimate both resolve.
    (data.tarps||[]).forEach(tarp=>{
      if(!tarp.bedId) return;                                  // a tarp with no bed isn't schedulable
      const linked = tarp.plantingId ? (data.plantings||[]).find(x=>x.id===tarp.plantingId) : null;
      const bed = (data.beds||[]).find(b=>b.id===tarp.bedId);
      const bm = tarp.bm != null ? tarp.bm : (bed && bed.len != null ? bed.len : 0);
      const cur = tarpRank(tarp.status);
      TARP_STEPS.forEach((s,i)=>{
        const dstr = tarp[s.df]; if(!dstr) return;
        const due=wkParse(dstr), done=cur>=tarpRank(s.stage);
        const overdue=isCurrent && !done && due<start, inWeek=due>=start && due<end;
        if(!overdue && !inWeek) return;
        const task=(data.tasks||[]).find(x=>x.name===s.label);
        rows.push({
          id:`tarp:${tarp.id}:${s.step}`, kind:"tarp", tarpStep:s.step, tarp, step:s,
          msLocked: cur>tarpRank(s.stage),                     // already past it — same lock as milestones
          // start = this job's own pinned clock time (null until dragged), so the calendar can
          // honour it exactly as it does a task's Start minute or a milestone's Sow start minute
          t:{done, repeat:0, start:tarp[s.startMin] ?? null, assignee:tarp[s.assignee]||""},
          p:{ id:`tarp:${tarp.id}`, crop:linked?`Tarp · after ${linked.crop}`:"Tarp",
              variety:"", bedIds:[tarp.bedId], bm, cropId:null },
          task: task || {name:s.label, category:"Bed prep"},
          due, overdue, inWeek,
          minutes: task && task.duration!=null ? task.duration*bm/15 : null,
        });
      });
    });
    // Scheduled sprays (Status "Planned") surface as one synthetic "spray" task each — the whole
    // spray is one job (unlike tarps, which split per bed), so a single row covers all its beds.
    // Same synthetic-planting trick as the branches above; ticking it done is handled app-side by
    // opening the log prefilled, which flips the record to Logged and drops it back out of here.
    (data.sprayApplications||[]).forEach(a=>{
      if(a.status!=="Planned" || !a.date) return;
      const due=wkParse(a.date), overdue=isCurrent && due<start, inWeek=due>=start && due<end;
      if(!overdue && !inWeek) return;
      const crops=(a.cropIds||[]).map(id=>(data.crops||{})[id]).filter(Boolean).join(", ");
      rows.push({
        id:`spray:${a.id}`, kind:"spray", app:a,
        t:{done:false, repeat:0, start:null, assignee:a.sprayedBy||""},
        p:{ id:`spray:${a.id}`, crop:crops||"Spray", variety:"", bedIds:(a.bedIds||[]).slice(), bm:0, cropId:null },
        task:{name:"Spray", category:"Spray"},
        due, overdue, inWeek, minutes:null,
      });
    });
    return {rows,start};
  }

  // Pure "what should ticking/unticking this milestone checkbox do" rule, factored out of the
  // app's wkToggleMilestone so both the app (optimistic UI + rollback) and anything else that
  // wants to advance a planting's status (e.g. an MCP tool) apply the exact same stepper.
  // Linear stepper (mirrors the Add-planting dialog's Progress checklist): ticking advances Status
  // to that stage; unticking the frontier steps back one; already-past-it is a locked no-op (null).
  function nextMilestoneStep(planting, df){
    const lc = apLifecycle(planting.tp ? "transplant" : "direct");
    const i = lc.findIndex(s=>s.df===df);
    if(i<0) return null;
    const cur=statusRank(planting.status), sr=statusRank(lc[i].stage);
    if(cur<sr) return {status: lc[i].stage};
    if(cur===sr) return {status: i===0?"Planned":lc[i-1].stage};
    return null; // already past this stage — locked, no-op
  }

  // sow/tp are the only milestones with an "actual date" counterpart (h1/h2 don't — see the
  // pl_tpActual comment above); maps a milestone df to the app-side planting property to stamp.
  const MILESTONE_ACTUAL_KEY = {sow:"sowActual", tp:"tpActual"};

  // Wraps nextMilestoneStep with the actual-date side effect: ticking a milestone forward stamps
  // today's date into its actual-date field (only if that field is still blank — never clobbers a
  // hand-entered or previously-stamped value); unticking the frontier clears it again, since that
  // reverses the whole "this happened" event, not just the Status label. Shared so the app and the
  // MCP server's advance_milestone tool can't diverge on this either.
  function buildMilestonePatch(planting, df, todayISO){
    const lc = apLifecycle(planting.tp ? "transplant" : "direct");
    const i = lc.findIndex(s=>s.df===df);
    if(i<0) return null;
    const cur=statusRank(planting.status), sr=statusRank(lc[i].stage);
    const actualKey = MILESTONE_ACTUAL_KEY[df];
    if(cur<sr){
      const patch={status: lc[i].stage};
      if(actualKey && !planting[actualKey]) patch[actualKey]=todayISO;
      return patch;
    }
    if(cur===sr){
      const patch={status: i===0?"Planned":lc[i-1].stage};
      if(actualKey) patch[actualKey]=null;
      return patch;
    }
    return null; // already past this stage — locked, no-op
  }

  // Shared by loadAll() (browser) and any Node-side loader so both parse Planting Tasks identically.
  function parsePlantingTaskRecord(r){
    const F=CFG.f;
    return {
      id:r.id,
      plantingId:(r.fields[F.pt_planting]||[])[0] || null,
      taskId:(r.fields[F.pt_task]||[])[0] || null,
      label:r.fields[F.pt_label] || "",
      anchor:r.fields[F.pt_anchor] || "",
      offset:num(r.fields[F.pt_offset]),
      due:r.fields[F.pt_due] || "",
      done:!!r.fields[F.pt_done],
      start: r.fields[F.pt_start]==null ? null : Number(r.fields[F.pt_start]),
      repeat:num(r.fields[F.pt_repeat]),
      until:r.fields[F.pt_until] || "",
      duration:num(r.fields[F.pt_duration]),
      assignee:r.fields[F.pt_assignee] || "",
      ttId:r.fields[F.pt_ttid] || "",
      gcalId:r.fields[F.pt_gcalid] || "",
      bedId:(r.fields[F.pt_bed]||[])[0] || null,
    };
  }

  // The following parse* functions mirror loadAll()'s inline mapping in roseberry-planner.html.
  // They're additive (the app keeps its own inline copy — see planner-shared.js's header comment
  // for why: low drift risk, since both sides key off the single CFG.f above) and exist so a
  // Node-side loader (e.g. an MCP server) can build the same shape of `data` without hand-copying
  // the mapping a second time.
  function parseCropsAndDefs(cropRecords){
    const crops={}, cropDefs={};
    cropRecords.forEach(c => {
      crops[c.id] = c.fields["Crop"] ?? "Crop";
      cropDefs[c.id] = readDefaultFields(c.fields, "cr");
      cropDefs[c.id].type = c.fields[CFG.f.cr_type] || "";
    });
    return {crops, cropDefs};
  }

  function parseBeds(bedRecords){
    const F=CFG.f;
    return bedRecords.map(b => ({
      id:b.id, name:b.fields[F.bed_name] ?? "?",
      block:(b.fields[F.bed_block]||"").trim(),
      len:num(b.fields[F.bed_len]), wid:num(b.fields[F.bed_wid]),
      order:num(b.fields[F.bed_order]),
      category:b.fields[F.bed_category]||"",
      tunnel:!!b.fields[F.bed_tunnel],
      notes:b.fields[F.bed_notes]||"",
    }));
  }

  // Bed Issues. `bedId` is the only required link. `types`/`crops` are the two exclusion lists —
  // both empty means the issue is informational and bedConflicts() will never return it.
  function parseBedIssues(issueRecords){
    const F=CFG.f;
    return issueRecords.map(i=>({
      id:i.id,
      bedId:(i.fields[F.bi_bed]||[])[0] || null,
      type:i.fields[F.bi_type]||"",
      severity:i.fields[F.bi_severity]||"Advisory",
      types:(i.fields[F.bi_types]||[]).slice(),
      cropIds:(i.fields[F.bi_crops]||[]).slice(),
      from:i.fields[F.bi_from]||"", until:i.fields[F.bi_until]||"",
      notes:i.fields[F.bi_notes]||"",
    }));
  }

  // Do two date ranges overlap? A null/blank end of a range means unbounded that way, so an issue
  // with no dates at all overlaps everything. Deliberately more permissive than the app's
  // windowsOverlap(): there, missing dates mean "unknown, assume a clash"; here they mean
  // "always applies", which is what a blank Active from/until on an issue actually says.
  function rangesOverlap(aStart, aEnd, bStart, bEnd){
    const d=v=>{ if(!v) return null; const t=new Date(v); return isNaN(t)?null:t; };
    const as=d(aStart), ae=d(aEnd), bs=d(bStart), be=d(bEnd);
    if(ae && bs && ae < bs) return false;
    if(be && as && be < as) return false;
    return true;
  }

  // Which of this bed's issues does this crop hit, during this window?
  // Returns [] when there's nothing to say — callers decide how loudly to render the result, and
  // no caller may treat a non-empty result as a reason to refuse the planting (see the Bed Issues
  // table description: flagging is advisory, always). `win` is planWindow()'s {s,e} shape.
  // A blank cropType matches nothing rather than everything — Crop.Type is often unset, and
  // flagging every typeless crop would train people to ignore the warning.
  function bedConflicts({ issues, bedId, cropId, cropType, win }){
    if(!bedId || !Array.isArray(issues)) return [];
    const w=win||{};
    return issues.filter(i=>{
      if(i.bedId!==bedId) return false;
      const byCrop = !!cropId && (i.cropIds||[]).includes(cropId);
      const byType = !!cropType && (i.types||[]).includes(cropType);
      if(!byCrop && !byType) return false;
      return rangesOverlap(i.from, i.until, w.s, w.e);
    });
  }

  function parseTasks(taskRecords){
    const F=CFG.f;
    return taskRecords.map(t => ({
      id:t.id,
      name:t.fields[F.tk_name] || "",
      category:t.fields[F.tk_cat] || "",
      desc:t.fields[F.tk_desc] || "",
      anchor:t.fields[F.tk_anchor] || "",
      offset:num(t.fields[F.tk_offset]),
      repeat:num(t.fields[F.tk_repeat]),
      until:t.fields[F.tk_until] || "",
      duration:num(t.fields[F.tk_duration]),
    })).sort((a,b)=>a.name.localeCompare(b.name));
  }

  function parsePlantings(plantingRecords, cropsMap){
    const F=CFG.f;
    return plantingRecords.map(p=>({
      id:p.id,
      cropId:(p.fields[F.pl_crop]||[])[0],
      crop: cropsMap[(p.fields[F.pl_crop]||[])[0]] || "—",
      variety:p.fields[F.pl_var]||"", status:p.fields[F.pl_status]||"", notes:p.fields[F.pl_notes]||"",
      sow:p.fields[F.pl_sow], tp:p.fields[F.pl_tp],
      h1:p.fields[F.pl_h1], h2:p.fields[F.pl_h2],
      sowStart:num(p.fields[F.pl_sowStart]), tpStart:num(p.fields[F.pl_tpStart]),
      sowAssignee:p.fields[F.pl_sowAssignee]||"", tpAssignee:p.fields[F.pl_tpAssignee]||"",
      h1Assignee:p.fields[F.pl_h1Assignee]||"", h2Assignee:p.fields[F.pl_h2Assignee]||"",
      sowTtId:p.fields[F.pl_sowTtId]||"", tpTtId:p.fields[F.pl_tpTtId]||"",
      sowGcalId:p.fields[F.pl_sowGcalId]||"", tpGcalId:p.fields[F.pl_tpGcalId]||"",
      group:p.fields[F.pl_group]||"", bm:num(p.fields[F.pl_bm]),
      bedIds:(p.fields[F.pl_bed]||[]).slice(),
      seedRef:p.fields[F.pl_seedRef]||"", traysSown:num(p.fields[F.pl_traysSown]),
      sowActual:p.fields[F.pl_sowActual]||"", tpActual:p.fields[F.pl_tpActual]||"",
      ...readDefaultFields(p.fields, "pl", PLANTING_DEFAULT_KEYS),
    }));
  }

  // Tarpings. `plantingId` is nullable by design — a tarp either terminates a specific crop or
  // stands alone on a bed, and both render identically. `bm` null means "the whole bed".
  function parseTarpings(tarpRecords){
    const F=CFG.f;
    return tarpRecords.map(t=>({
      id:t.id,
      bedId:(t.fields[F.tr_bed]||[])[0] || null,
      plantingId:(t.fields[F.tr_planting]||[])[0] || null,
      start:t.fields[F.tr_start]||"", end:t.fields[F.tr_end]||"",
      bm:num(t.fields[F.tr_bm]),
      status:t.fields[F.tr_status]||"Planned",
      laidActual:t.fields[F.tr_laidActual]||"", pulledActual:t.fields[F.tr_pulledActual]||"",
      notes:t.fields[F.tr_notes]||"",
      // per-job scheduling + sync state; keys match TARP_STEPS' assignee/startMin/ttId/gcalId
      layAssignee:t.fields[F.tr_layAssignee]||"", pullAssignee:t.fields[F.tr_pullAssignee]||"",
      layStart:num(t.fields[F.tr_layStart]), pullStart:num(t.fields[F.tr_pullStart]),
      layTtId:t.fields[F.tr_layTtId]||"", pullTtId:t.fields[F.tr_pullTtId]||"",
      layGcalId:t.fields[F.tr_layGcalId]||"", pullGcalId:t.fields[F.tr_pullGcalId]||"",
    }));
  }

  // Tarp lifecycle, deliberately shaped like apLifecycle so the weekly planner can treat a tarp's
  // two jobs as milestones: laying it puts the tarp On, pulling it marks it Removed.
  const TARP_STATUS_ORDER=["Planned","On","Removed"];
  function tarpRank(s){ const i=TARP_STATUS_ORDER.indexOf(s); return i<0?0:i; }
  // Each step carries the full set of keys for its own job — app-side property names (assignee,
  // startMin, ttId, gcalId) and the matching CFG.f keys (fAssignee, fStart, fTt, fGcal). Consumers
  // look everything up through the step, so no caller has to branch on lay-vs-pull.
  const TARP_STEPS=[
    {step:"lay",  label:"Lay tarp",  stage:"On",      df:"start", actual:"laidActual",
     assignee:"layAssignee",  startMin:"layStart",  ttId:"layTtId",  gcalId:"layGcalId",
     fAssignee:"tr_layAssignee",  fStart:"tr_layStart",  fTt:"tr_layTtId",  fGcal:"tr_layGcalId"},
    {step:"pull", label:"Pull tarp", stage:"Removed", df:"end",   actual:"pulledActual",
     assignee:"pullAssignee", startMin:"pullStart", ttId:"pullTtId", gcalId:"pullGcalId",
     fAssignee:"tr_pullAssignee", fStart:"tr_pullStart", fTt:"tr_pullTtId", fGcal:"tr_pullGcalId"},
  ];
  function tarpStep(step){ return TARP_STEPS.find(s=>s.step===step) || null; }

  // Tarp analogue of buildMilestonePatch — same linear-stepper contract (tick advances to that
  // stage and stamps the actual date if blank; unticking the frontier steps back one and clears
  // the stamp; already-past-it is a locked no-op). Returns app-side keys, not Airtable names.
  function buildTarpPatch(tarp, step, todayISO){
    const i=TARP_STEPS.findIndex(s=>s.step===step);
    if(i<0) return null;
    const cur=tarpRank(tarp.status), sr=tarpRank(TARP_STEPS[i].stage);
    const actualKey=TARP_STEPS[i].actual;
    if(cur<sr){
      const patch={status:TARP_STEPS[i].stage};
      if(!tarp[actualKey]) patch[actualKey]=todayISO;
      return patch;
    }
    if(cur===sr){
      const patch={status: i===0?"Planned":TARP_STEPS[i-1].stage};
      patch[actualKey]=null;
      return patch;
    }
    return null; // already past this step — locked
  }

  /* ---------- Spray log ---------- */
  // The five spray tables are parsed here (like Tarpings/Bed Issues) so any Node-side reader —
  // e.g. the one-off migration script — builds the same shapes the browser app does. Items are
  // returned flat; the caller (loadAll / the script) nests them onto their parent by id.
  function parseSprayProducts(recs){
    const F=CFG.f;
    return recs.map(r=>({
      id:r.id,
      name:r.fields[F.spp_name]||"",
      category:r.fields[F.spp_cat]||"",
      unit:r.fields[F.spp_unit]||"",
      defaultRate:num(r.fields[F.spp_rate]),
      basis:r.fields[F.spp_basis]||"",
      whp:num(r.fields[F.spp_whp]),
      organic:r.fields[F.spp_organic]||"",
      active:r.fields[F.spp_active]!==false,   // default-on: only an explicit false retires it
      notes:r.fields[F.spp_notes]||"",
    })).sort((a,b)=>a.name.localeCompare(b.name));
  }

  function parseSprayMixes(recs){
    const F=CFG.f;
    return recs.map(r=>({
      id:r.id,
      name:r.fields[F.smx_name]||"",
      target:r.fields[F.smx_target]||"",
      water:num(r.fields[F.smx_water]),
      waterBasis:r.fields[F.smx_waterBasis]||"",
      method:r.fields[F.smx_method]||"",
      whp:num(r.fields[F.smx_whp]),
      favourite:!!r.fields[F.smx_fav],
      active:r.fields[F.smx_active]!==false,
      items:[],
    }));
  }

  function parseSprayMixItems(recs){
    const F=CFG.f;
    return recs.map(r=>({
      id:r.id,
      mixId:(r.fields[F.smi_mix]||[])[0]||null,
      productId:(r.fields[F.smi_product]||[])[0]||null,
      rate:num(r.fields[F.smi_rate]),
      unit:r.fields[F.smi_unit]||"",
      order:num(r.fields[F.smi_order]),
    }));
  }

  function parseSprayApplications(recs){
    const F=CFG.f;
    return recs.map(r=>({
      id:r.id,
      name:r.fields[F.sap_name]||"",
      date:r.fields[F.sap_date]||"",
      sprayedBy:r.fields[F.sap_by]||"",
      bedIds:(r.fields[F.sap_beds]||[]).slice(),
      cropIds:(r.fields[F.sap_crops]||[]).slice(),
      locationNote:r.fields[F.sap_locNote]||"",
      fromMixId:(r.fields[F.sap_fromMix]||[])[0]||null,
      method:r.fields[F.sap_method]||"",
      amount:num(r.fields[F.sap_amount]),
      amountUnit:r.fields[F.sap_amountUnit]||"",
      reason:r.fields[F.sap_reason]||"",
      whp:num(r.fields[F.sap_whp]),
      photos:(r.fields[F.sap_photos]||[]).slice(),
      notes:r.fields[F.sap_notes]||"",
      legacyRef:r.fields[F.sap_legacy]||"",
      status:r.fields[F.sap_status]||"Logged",   // blank ⇒ Logged, so legacy rows need no backfill
      followUpOfId:(r.fields[F.sap_followUp]||[])[0]||null,
      items:[],
    }));
  }

  function parseSprayApplicationItems(recs){
    const F=CFG.f;
    return recs.map(r=>({
      id:r.id,
      applicationId:(r.fields[F.sai_app]||[])[0]||null,
      productId:(r.fields[F.sai_product]||[])[0]||null,
      rate:num(r.fields[F.sai_rate]),
      unit:r.fields[F.sai_unit]||"",
      amountUsed:num(r.fields[F.sai_amountUsed]),
      order:num(r.fields[F.sai_order]),
    }));
  }

  // Nest flat item rows onto their parent (mix or application) by id, sorted by Order then id so
  // the shed list and record detail render ingredients in a stable, editable order.
  function attachSprayItems(parents, items, parentKey){
    const byParent={};
    (items||[]).forEach(it=>{ const p=it[parentKey]; if(p) (byParent[p] ||= []).push(it); });
    parents.forEach(p=>{
      p.items=(byParent[p.id]||[]).slice().sort((a,b)=>((a.order??1e9)-(b.order??1e9))||String(a.id).localeCompare(b.id));
    });
    return parents;
  }

  // An application's / mix's withholding period is the longest WHP of the products it contains.
  // `productsById` maps product id -> parsed product (with a `whp`). Returns 0 when nothing is
  // known, so a nutrient-only mix never raises a false harvest flag.
  function mixWhp(items, productsById){
    let max=0;
    (items||[]).forEach(it=>{
      const p=productsById&&productsById[it.productId];
      const w=p&&p.whp!=null?p.whp:0;
      if(w>max) max=w;
    });
    return max;
  }

  // The date a bed sprayed on `dateISO` with `whp` days becomes safe to harvest again. WHP 0 ⇒ the
  // application date itself (never flags, since applications are dated on/before today).
  function safeAfterISO(dateISO, whp){
    if(!dateISO) return "";
    return wkISO(wkAddDays(wkParse(dateISO), whp||0));
  }

  // The application currently keeping `bedId` inside a withholding period on `onISO` (today by
  // default), or null. When several overlap, returns the one with the latest safe-after date (the
  // binding one). ISO date strings compare correctly with <, so no Date objects are needed here.
  function bedWhpActive(applications, bedId, onISO){
    onISO = onISO || wkISO(new Date());
    let best=null;
    (applications||[]).forEach(a=>{
      if(!a.date || !(a.bedIds||[]).includes(bedId)) return;
      const whp = a.whp!=null ? a.whp : 0;
      if(!whp) return;
      const safe = safeAfterISO(a.date, whp);
      if(a.date <= onISO && onISO < safe && (!best || safe > best.safeAfter)){
        best={application:a, safeAfter:safe, whp};
      }
    });
    return best;
  }

  /* ---------- Bed placement suggestions ---------- */
  // Ranks candidate beds for a planting (not yet saved, or being re-homed) by how well each bed
  // fits its date window + size, whether the grower's own Bed Issues flag it for this crop/type
  // (reusing bedConflicts above rather than inventing a separate rotation-interval guess), whether
  // it keeps a succession group together, and whether the block prefers this crop's type.
  // Deliberately advisory only — same contract as bedConflicts/bedTarpedIn: a bed is only ever
  // excluded from the list for a hard physical reason (too small, already full), never a soft one.
  const SUGGEST_WEIGHTS = { fit:0.40, rotation:0.30, succession:0.15, blockPref:0.15 };

  // Ground-occupancy window for a planting — start = Sow date, matching planWindow()'s existing
  // convention, so this engine never disagrees with the app's own drag-fit / Bed Issue checks
  // about what "occupies the bed" means.
  function groundWindow(p){
    const s = p.sow || null;
    const e = p.h2 || p.h1 || s;
    return { s, e };
  }
  function isoWindowsOverlap(aS, aE, bS, bE){
    if(!bS && !bE) return false;                 // occupant has no dates ⇒ doesn't block
    if(!aS || !aE || !bS || !bE) return true;     // partial dates ⇒ assume a clash (safe default)
    return aS<=bE && bS<=aE;
  }
  function monthsBetweenISO(aISO,bISO){
    if(!aISO||!bISO) return null;
    return Math.abs(wkParse(bISO)-wkParse(aISO))/(1000*60*60*24*30.44);
  }
  function indexPlantingsByBed(data, excludePlantingId){
    const byBed={};
    (data.plantings||[]).forEach(p=>{
      if(p.id===excludePlantingId) return;
      const bedId=p.bedIds[0]; if(!bedId) return;
      (byBed[bedId] ||= []).push(p);
    });
    return byBed;
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const fmtM = x => (Math.round(x*10)/10).toString();
  // Same "unknown-size occupant fills the whole bed" convention as the app's own bedFreeInfo().
  function bedUsage(bed, overlapping){
    let used=0, unknownOccupant=false;
    overlapping.forEach(p=>{ if(p.bm!=null) used+=p.bm; else unknownOccupant=true; });
    const usedEff = unknownOccupant ? bed.len : used;
    return { used:usedEff, free: bed.len - usedEff };
  }
  function excludedCandidate(bed, geometryKnown, reason){
    return { bed, hardExclude:true, geometryKnown, score:0, factors:{}, reasons:[reason] };
  }

  function scoreBedCandidate(bed, input, byBed, data){
    const groundStart = input.sow || null;
    const groundEnd = input.h2 || input.h1 || groundStart;
    const occupants = byBed[bed.id] || [];
    const overlapping = occupants.filter(p=>{
      const w=groundWindow(p);
      return isoWindowsOverlap(groundStart, groundEnd, w.s, w.e);
    });
    const geometryKnown = bed.len != null;
    const needM = input.bm!=null ? input.bm : (geometryKnown ? bed.len : null); // unknown size ⇒ needs a whole free bed

    if(geometryKnown){
      const { free } = bedUsage(bed, overlapping);
      const need = needM!=null ? needM : bed.len;
      if(need > bed.len) return excludedCandidate(bed, geometryKnown, `Bed is only ${fmtM(bed.len)} m — this needs ${fmtM(need)} m.`);
      if(free < need - 0.001) return excludedCandidate(bed, geometryKnown, `Only ${fmtM(Math.max(0,free))} m free during that window (needs ${fmtM(need)} m).`);
    } else if(overlapping.length){
      return excludedCandidate(bed, geometryKnown, "Bed size unknown and it looks occupied during that window — can't verify it fits.");
    }

    // ---- fit / fragmentation ----
    let fit;
    if(geometryKnown){
      const { used, free } = bedUsage(bed, overlapping);
      const need = needM!=null ? needM : bed.len;
      const leftover = free - need;
      let s = clamp01(1 - leftover/bed.len);
      if(used===0 && need < 0.4*bed.len) s *= 0.85;   // fragmentation penalty: don't carve a sliver out of an empty long bed
      fit = { score:s, applicable:true, reason:`${fmtM(free)} m free, uses ${fmtM(need)} m, leaves ${fmtM(Math.max(0,leftover))} m.` };
    } else {
      fit = { score:0.5, applicable:true, reason:"No recorded bed size — appears free, but fit isn't verified." };
    }
    // Tarps don't hard-block (same advisory contract as bedTarpedIn) — just softens fit + flags it.
    const tarpHit = (data.tarps||[]).some(t=> t.bedId===bed.id && t.start && t.end && isoWindowsOverlap(groundStart, groundEnd, t.start, t.end));
    if(tarpHit) fit = { score: fit.score*0.5, applicable:true, reason: (fit.reason+" Bed is tarped during part of this window.").trim() };

    // ---- rotation: reuse the grower's own curated Bed Issues, not a guessed heuristic ----
    const cropType = (data.cropDefs[input.cropId]||{}).type || "";
    const conflicts = bedConflicts({ issues:data.bedIssues, bedId:bed.id, cropId:input.cropId, cropType, win:{s:groundStart,e:groundEnd} });
    let rotation;
    if(!conflicts.length){
      rotation = { score:1, applicable:true, reason:"No recorded bed issues for this crop." };
    } else {
      const avoid = conflicts.some(c=>c.severity==="Avoid");
      const label = conflicts.map(c=>(c.type||"Issue")+(c.notes?" — "+c.notes.split("\n")[0].trim():"")).join("; ");
      rotation = { score: avoid?0.05:0.45, applicable:true, reason:(avoid?"Avoid: ":"")+label };
    }

    // ---- succession continuity ----
    let succession;
    const siblings = input.group ? (data.plantings||[]).filter(p=> p.id!==input.excludePlantingId && p.group===input.group && p.bedIds[0]) : [];
    if(!siblings.length){
      succession = { score:1, applicable:false, reason:"" };
    } else {
      let best=0.2, reason="Different block from its succession siblings.";
      siblings.forEach(sib=>{
        const sibBed=(data.beds||[]).find(b=>b.id===sib.bedIds[0]); if(!sibBed) return;
        if(sibBed.id===bed.id){ if(best<1){ best=1; reason="Same bed as a succession sibling."; } }
        else if(sibBed.block===bed.block){
          let s,r;
          if(sibBed.order!=null && bed.order!=null){ s=Math.max(0.3, 0.85-0.1*Math.abs(sibBed.order-bed.order)); r="Close to its succession siblings."; }
          else { s=0.6; r="Same block as its succession siblings."; }
          if(s>best){ best=s; reason=r; }
        }
      });
      succession = { score:best, applicable:true, reason };
    }

    // ---- block-type preference ----
    let blockPref;
    const block=(data.blocks||[]).find(b=>String(b.name).trim()===bed.block);
    if(!block || !block.preferredCropTypes || !block.preferredCropTypes.length || !cropType){
      blockPref = { score:1, applicable:false, reason:"" };
    } else {
      const match = block.preferredCropTypes.includes(cropType);
      blockPref = { score: match?1:0.4, applicable:true, reason: match ? `Block prefers ${cropType}.` : `Block doesn't list ${cropType} as preferred.` };
    }

    const factors = { fit, rotation, succession, blockPref };
    let wSum=0, sSum=0;
    Object.keys(factors).forEach(k=>{ const f=factors[k]; if(f.applicable){ wSum+=SUGGEST_WEIGHTS[k]; sSum+=SUGGEST_WEIGHTS[k]*f.score; } });
    const score = Math.round(100*(wSum>0 ? sSum/wSum : fit.score));

    const reasons = Object.keys(factors)
      .filter(k=>factors[k].applicable && factors[k].reason)
      .sort((a,b)=>factors[a].score-factors[b].score)
      .slice(0,2)
      .map(k=>factors[k].reason);
    if(!reasons.length) reasons.push(fit.reason);

    return { bed, hardExclude:false, geometryKnown, score, factors, reasons };
  }

  // input: { cropId, bm, sow, h1, h2, group, excludePlantingId }
  function suggestBedsForPlanting(data, input, opts={}){
    const byBed = indexPlantingsByBed(data, input.excludePlantingId);
    const scored = (data.beds||[]).map(bed => scoreBedCandidate(bed, input, byBed, data));
    const candidates = scored.filter(r=>!r.hardExclude)
      .sort((a,b)=> (b.geometryKnown - a.geometryKnown) || (b.score - a.score));
    return { candidates: candidates.slice(0, opts.limit ?? 8), excluded: scored.filter(r=>r.hardExclude), total: candidates.length };
  }

  // Generic Airtable REST wrapper for Node-side use (the browser app keeps its own copy closed
  // over the mutable `PAT` global — see this file's header comment for why it isn't shared).
  // getPat: () => string, called fresh on every request.
  function createAirtableClient(getPat){
    async function atFetch(base, table, opts={}){
      let records=[], offset;
      do{
        const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
        url.searchParams.set("pageSize","100");
        if(offset) url.searchParams.set("offset",offset);
        const r = await fetch(url, {headers:{Authorization:`Bearer ${getPat()}`}});
        if(!r.ok){
          const t = await r.text().catch(()=> "");
          throw new Error(`${table.slice(0,6)}… ${r.status}: ${t.slice(0,120)}`);
        }
        const j = await r.json();
        records = records.concat(j.records);
        offset = j.offset;
      } while(offset);
      return records;
    }
    async function atPatch(base,table,id,fields){
      const r=await fetch(`https://api.airtable.com/v0/${base}/${table}/${id}`,{
        method:"PATCH",
        headers:{Authorization:`Bearer ${getPat()}`,"Content-Type":"application/json"},
        body:JSON.stringify({fields,typecast:true}),
      });
      if(!r.ok){const t=await r.text().catch(()=>"");throw new Error(`${r.status}: ${t.slice(0,160)}`);}
      return r.json();
    }
    async function atCreate(base,table,recordList){
      const created=[];
      for(let i=0;i<recordList.length;i+=10){
        const chunk=recordList.slice(i,i+10).map(fields=>({fields}));
        const r=await fetch(`https://api.airtable.com/v0/${base}/${table}`,{
          method:"POST",
          headers:{Authorization:`Bearer ${getPat()}`,"Content-Type":"application/json"},
          body:JSON.stringify({records:chunk,typecast:true}),
        });
        if(!r.ok){const t=await r.text().catch(()=>"");throw new Error(`${r.status}: ${t.slice(0,160)}`);}
        const j=await r.json(); created.push(...j.records);
      }
      return created;
    }
    async function atDelete(base,table,ids){
      for(let i=0;i<ids.length;i+=10){
        const chunk=ids.slice(i,i+10);
        const url=new URL(`https://api.airtable.com/v0/${base}/${table}`);
        chunk.forEach(id=>url.searchParams.append("records[]",id));
        const r=await fetch(url,{method:"DELETE",headers:{Authorization:`Bearer ${getPat()}`}});
        if(!r.ok){const t=await r.text().catch(()=>"");throw new Error(`${r.status}: ${t.slice(0,160)}`);}
      }
    }
    return {atFetch, atPatch, atCreate, atDelete};
  }

  return {
    CFG, num,
    DEFAULT_KEYS, SELECT_DEFAULT_KEYS, PLANTING_DEFAULT_KEYS, readDefaultFields,
    STATUS_ORDER, statusRank, apLifecycle,
    wkParse, wkISO, wkMonday, wkAddDays, wkSameDay,
    ctTaskById, bedNameOf, wkCollect, nextMilestoneStep, buildMilestonePatch,
    TARP_STATUS_ORDER, TARP_STEPS, tarpStep, tarpRank, buildTarpPatch,
    parsePlantingTaskRecord, parseCropsAndDefs, parseBeds, parseTasks, parsePlantings, parseTarpings,
    parseBedIssues, rangesOverlap, bedConflicts,
    parseSprayProducts, parseSprayMixes, parseSprayMixItems, parseSprayApplications,
    parseSprayApplicationItems, attachSprayItems, mixWhp, safeAfterISO, bedWhpActive,
    SUGGEST_WEIGHTS, groundWindow, isoWindowsOverlap, indexPlantingsByBed, scoreBedCandidate, suggestBedsForPlanting,
    createAirtableClient,
  };
});
