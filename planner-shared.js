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
    },
    f: { // field names (readable; rename in Airtable => update here)
      blk_name:"Name", blk_x:"Map X", blk_y:"Map Y", blk_orient:"Orientation", blk_prefTypes:"Preferred Crop Types",
      bed_name:"Bed", bed_block:"Block", bed_len:"Length m", bed_wid:"Width m", bed_order:"Order in block",
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
      pl_seedRef:"Seed ref", pl_traysSown:"Trays sown", pl_sowActual:"Actual sow date",
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
  function wkCollect(data, wkStartISO, now){
    now = now || new Date();
    const start=wkParse(wkStartISO), end=wkAddDays(start,7), rows=[];
    // Overdue (still-open tasks due before the window) only surface on the *current* week.
    const isCurrent=wkSameDay(start, wkMonday(now));
    (data.plantingTasks||[]).forEach(t=>{
      if(!t.due) return;
      const p=(data.plantings||[]).find(x=>x.id===t.plantingId); if(!p) return;
      const task=ctTaskById(data,t.taskId)||{name:"(task)",category:""};
      const due=wkParse(t.due), overdue=isCurrent && !t.done && due<start, inWeek=due>=start && due<end;
      if(!overdue && !inWeek) return;
      const dur=t.duration||task.duration||0;
      rows.push({ id:t.id, t, p, task, due, overdue, inWeek, minutes:dur*(p.bm||0)/15 });
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

  // Shared by loadAll() (browser) and any Node-side loader so both parse Planting Tasks identically.
  function parsePlantingTaskRecord(r){
    const F=CFG.f;
    return {
      id:r.id,
      plantingId:(r.fields[F.pt_planting]||[])[0] || null,
      taskId:(r.fields[F.pt_task]||[])[0] || null,
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
    }));
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
      sowActual:p.fields[F.pl_sowActual]||"",
      ...readDefaultFields(p.fields, "pl", PLANTING_DEFAULT_KEYS),
    }));
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
    ctTaskById, bedNameOf, wkCollect, nextMilestoneStep,
    parsePlantingTaskRecord, parseCropsAndDefs, parseBeds, parseTasks, parsePlantings,
    createAirtableClient,
  };
});
