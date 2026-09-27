const OBSERVER_V2 = {
  contract: "sosl_apps_script_observer_v0.2.0",
  controlSpreadsheetId: "1G1O2cjMRGxwn3d1t2NjBo93c20dX84G5dH_uMLA46Pw",
  stateKey: "GIL_OBSERVER_V2_STATE",
  githubTokenKey: "GITHUB_FINE_GRAINED_TOKEN",
  triggerFunction: "observerRun"
};

function rowsToObjects_(values) {
  if (!values || values.length < 2) return [];
  const header = values[0].map(String);
  return values.slice(1)
    .filter(row => row.some(v => String(v || "").trim() !== ""))
    .map(row => {
      const out = {};
      header.forEach((key, i) => out[key] = row[i] == null ? "" : String(row[i]));
      return out;
    });
}

function kv_(values) {
  const out = {};
  (values || []).slice(1).forEach(row => {
    if (row[0]) out[String(row[0])] = row[1] == null ? "" : String(row[1]);
  });
  return out;
}

function sheetValues_(spreadsheetId, sheetName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("SHEET_NOT_FOUND_" + sheetName);
  return sheet.getDataRange().getDisplayValues();
}

function loadControl_() {
  const id = OBSERVER_V2.controlSpreadsheetId;
  const global = kv_(sheetValues_(id, "GLOBAL"));
  const databases = rowsToObjects_(sheetValues_(id, "DATABASES"));
  const executors = rowsToObjects_(sheetValues_(id, "EXECUTORS"));
  if (global.control_version !== "v0.1") throw new Error("UNSUPPORTED_CONTROL_VERSION");
  return {global, databases, executors};
}

function manifestRows_(id) {
  return rowsToObjects_(sheetValues_(id, "FONTES"));
}

function sourceClass_(row) {
  const desired=String(row.desired_presence||"");
  const state=String(row.state||"");
  const body=String(row.body_present||"");
  const sync=String(row.estado_sync||"");
  if (desired==="PRESENT" && state==="ACTIVE" && body==="1" && sync==="OK") return "OPERATIONAL";
  if (desired==="PRESENT" && state==="INACTIVE" && body==="1" && sync==="CONGELADO_OK") return "FROZEN_TEST";
  if (
    desired==="ABSENT" &&
    state==="INACTIVE" &&
    body==="1" &&
    /RETIRADA_PENDENTE_CORPO/i.test(sync)
  ) return "RETIREMENT_PENDING";
  return "OTHER";
}

function buildPlan_(control) {
  const max = Number(control.global.max_databases_per_run || 8);
  const dbs = control.databases
    .filter(db => String(db.enabled).toUpperCase()==="TRUE" && String(db.observer_enabled).toUpperCase()==="TRUE")
    .sort((a,b)=>Number(b.priority||0)-Number(a.priority||0))
    .slice(0,max);

  const fileToDatabases = {};
  const databasePlans = {};

  dbs.forEach(db => {
    const rows = manifestRows_(db.manifest_spreadsheet_id);
    const watched = rows.filter(row => {
      const c = sourceClass_(row);
      return c==="OPERATIONAL" || c==="FROZEN_TEST" || c==="RETIREMENT_PENDING";
    });
    const byFile = {};
    watched.forEach(row => {
      const id = String(row.drive_file_id || "").trim();
      if (!id) return;
      byFile[id] = row;
      if (!fileToDatabases[id]) fileToDatabases[id]=[];
      if (!fileToDatabases[id].includes(db.database_id)) fileToDatabases[id].push(db.database_id);
    });

    const registryId = String(db.registry_spreadsheet_id || "").trim();
    if (registryId) {
      if (!fileToDatabases[registryId]) fileToDatabases[registryId]=[];
      if (!fileToDatabases[registryId].includes(db.database_id)) fileToDatabases[registryId].push(db.database_id);
    }

    databasePlans[db.database_id] = {
      database: db,
      manifestByFileId: byFile,
      registryId
    };
  });

  return {fileToDatabases, databasePlans};
}

function loadState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(OBSERVER_V2.stateKey);
  if (!raw) return {pageToken:null,migrationReconciled:false,dirty:{},lastCycleAt:null};
  return JSON.parse(raw);
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(OBSERVER_V2.stateKey, JSON.stringify(state));
}

function markDirty_(state, dbId, fileId, reason, nowMs, observedRevision) {
  if (!state.dirty[dbId]) {
    state.dirty[dbId] = {firstSeenAt:nowMs,lastDispatchAt:null,files:{},reasons:{}};
  }
  const previous=state.dirty[dbId].files[fileId];
  const previousRevision=previous && typeof previous==="object"
    ? String(previous.observedRevision||"")
    : "";
  state.dirty[dbId].files[fileId]={
    observedRevision:String(observedRevision||previousRevision||""),
    lastSeenAt:nowMs
  };
  state.dirty[dbId].reasons[reason]=true;
}

function revision_(version) {
  return "drive-version:" + String(version);
}

function migrationReconcile_(state, plan, nowMs) {
  let checked=0, mismatches=0;
  Object.keys(plan.databasePlans).forEach(dbId => {
    const p=plan.databasePlans[dbId];
    Object.keys(p.manifestByFileId).forEach(fileId => {
      checked++;
      const row=p.manifestByFileId[fileId];
      const meta=Drive.Files.get(fileId,{fields:"id,version,trashed"});
      if (meta.trashed===true || !meta.version) {
        markDirty_(state,dbId,fileId,"MIGRATION_METADATA_INVALID",nowMs,"REMOVED");
        mismatches++;
        return;
      }
      const live=revision_(meta.version);
      if (live!==String(row.db_processed_revision||"") || live!==String(row.drive_revision||"")) {
        markDirty_(state,dbId,fileId,"MIGRATION_REVISION_MISMATCH",nowMs,live);
        mismatches++;
      }
    });
  });
  state.migrationReconciled=true;
  return {checked,mismatches};
}

function applyChanges_(state, plan, nowMs) {
  let token=state.pageToken, pages=0, seen=0, relevant=0;
  while (token) {
    const response=Drive.Changes.list(token,{
      pageSize:1000,
      spaces:"drive",
      includeItemsFromAllDrives:true,
      supportsAllDrives:true,
      fields:"nextPageToken,newStartPageToken,changes(fileId,removed,file(id,trashed,version))"
    });
    pages++;
    (response.changes||[]).forEach(change => {
      seen++;
      const id=String(change.fileId||"");
      const dbs=plan.fileToDatabases[id]||[];
      if (!dbs.length) return;
      relevant++;
      const observedRevision=
        change.removed===true || change.file?.trashed===true
          ? "REMOVED"
          : change.file?.version
            ? revision_(change.file.version)
            : "";
      dbs.forEach(dbId => {
        const p=plan.databasePlans[dbId];
        markDirty_(
          state,
          dbId,
          id,
          id===p.registryId?"REGISTRY_CHANGED":"SOURCE_CHANGED",
          nowMs,
          observedRevision
        );
      });
    });
    if (response.nextPageToken) {
      token=response.nextPageToken;
    } else {
      state.pageToken=response.newStartPageToken||token;
      break;
    }
  }
  return {pages,seen,relevant};
}

function clearAcknowledged_(state, plan) {
  let cleared=0;
  Object.keys(state.dirty).forEach(dbId => {
    const dirty=state.dirty[dbId];
    const p=plan.databasePlans[dbId];
    if (!p) return;

    Object.keys(dirty.files).forEach(fileId => {
      if (fileId===p.registryId) return;
      const row=p.manifestByFileId[fileId];
      if (!row) return;
      const dirtyFile=dirty.files[fileId];
      const expected=
        dirtyFile && typeof dirtyFile==="object"
          ? String(dirtyFile.observedRevision||"")
          : "";
      if (!expected || expected==="REMOVED") return;
      const drive=String(row.drive_revision||"");
      const processed=String(row.db_processed_revision||"");
      const sync=String(row.db_sync_status||"");
      if (
        drive===expected &&
        processed===expected &&
        !/DIRTY|ERROR|PENDING|PENDENTE|RETIRADA/i.test(sync)
      ) {
        delete dirty.files[fileId];
        cleared++;
      }
    });

    if (!Object.keys(dirty.files).length) delete state.dirty[dbId];
  });
  return cleared;
}

function activeExecutor_(control) {
  const id=String(control.global.active_executor||"NONE");
  if (id==="NONE") return null;
  const row=control.executors.find(x=>x.executor_id===id);
  if (!row) throw new Error("ACTIVE_EXECUTOR_NOT_FOUND");
  if (String(row.enabled).toUpperCase()!=="TRUE") throw new Error("ACTIVE_EXECUTOR_DISABLED");
  if (!row.repository_full_name || !row.workflow_file) throw new Error("ACTIVE_EXECUTOR_INCOMPLETE");
  return row;
}

function dispatchGitHub_(executor, dbId, reasons) {
  const token=PropertiesService.getScriptProperties().getProperty(OBSERVER_V2.githubTokenKey);
  if (!token) throw new Error("GITHUB_FINE_GRAINED_TOKEN_MISSING");

  const url="https://api.github.com/repos/"+executor.repository_full_name+
    "/actions/workflows/"+encodeURIComponent(executor.workflow_file)+"/dispatches";

  const response=UrlFetchApp.fetch(url,{
    method:"post",
    muteHttpExceptions:true,
    contentType:"application/json",
    headers:{
      Authorization:"Bearer "+token,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28"
    },
    payload:JSON.stringify({
      ref:"main",
      inputs:{
        database_id:dbId,
        observer_contract:OBSERVER_V2.contract,
        trigger_reason:reasons.join(",").slice(0,200)
      }
    })
  });

  const status=response.getResponseCode();
  if (status<200 || status>=300) {
    throw new Error("GITHUB_DISPATCH_FAILED_"+status+" "+response.getContentText().slice(0,300));
  }
  return {status};
}

function observerCycle_(forceNoDispatch) {
  const started=Date.now();
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(1000)) return {ok:true,status:"SKIPPED_LOCKED"};

  try {
    const control=loadControl_();
    if (String(control.global.observer_enabled).toUpperCase()!=="TRUE") {
      return {ok:true,status:"OBSERVER_DISABLED"};
    }

    const state=loadState_();
    const plan=buildPlan_(control);
    const nowMs=Date.now();
    let baseline=false, migration=null;

    if (!state.pageToken) {
      const start=Drive.Changes.getStartPageToken({supportsAllDrives:true});
      state.pageToken=start.startPageToken;
      baseline=true;
    }

    if (!state.migrationReconciled) migration=migrationReconcile_(state,plan,nowMs);

    const changes=applyChanges_(state,plan,nowMs);
    const cleared=clearAcknowledged_(state,plan);

    const debounceMs=Number(control.global.debounce_minutes||20)*60*1000;
    const enabled=String(control.global.dispatch_enabled).toUpperCase()==="TRUE";
    const mode=String(control.global.observer_mode||"DRY_RUN");
    const ready=[], dispatches=[];

    Object.keys(state.dirty).forEach(dbId => {
      const dirty=state.dirty[dbId];
      if (nowMs-Number(dirty.firstSeenAt||nowMs)<debounceMs) return;
      ready.push(dbId);

      if (!enabled || forceNoDispatch || mode==="DRY_RUN") return;
      const last=Number(dirty.lastDispatchAt||0);
      if (last && nowMs-last<debounceMs) return;

      const executor=activeExecutor_(control);
      if (!executor) throw new Error("NO_ACTIVE_EXECUTOR");
      const result=dispatchGitHub_(executor,dbId,Object.keys(dirty.reasons||{}));
      dirty.lastDispatchAt=nowMs;
      dispatches.push({database_id:dbId,status:result.status});
    });

    state.lastCycleAt=nowMs;
    saveState_(state);

    const result={
      ok:true,
      contract:OBSERVER_V2.contract,
      status:dispatches.length?"DISPATCHED":
        ready.length?"DIRTY_READY":
        Object.keys(state.dirty).length?"DIRTY_DEBOUNCE":
        baseline?"BASELINE_INITIALIZED":"CLEAN",
      databases:Object.keys(plan.databasePlans),
      watched_files:Object.keys(plan.fileToDatabases).length,
      migration,
      pages_scanned:changes.pages,
      changes_seen:changes.seen,
      relevant_changes:changes.relevant,
      dirty_databases:Object.keys(state.dirty).length,
      debounce_ready_databases:ready.length,
      dispatch_enabled:enabled,
      observer_mode:mode,
      dispatches,
      ack_cleared:cleared,
      duration_ms:Date.now()-started
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function observerRun() { return observerCycle_(false); }
function observerProbe() { return observerCycle_(true); }

function observerState() {
  return {
    contract:OBSERVER_V2.contract,
    state:loadState_(),
    has_github_token:Boolean(PropertiesService.getScriptProperties().getProperty(OBSERVER_V2.githubTokenKey)),
    trigger_count:ScriptApp.getProjectTriggers()
      .filter(t=>t.getHandlerFunction()===OBSERVER_V2.triggerFunction).length
  };
}

function removeObserverTriggers() {
  const handlers=new Set([OBSERVER_V2.triggerFunction,"observerProbe"]);
  ScriptApp.getProjectTriggers()
    .filter(t=>handlers.has(t.getHandlerFunction()))
    .forEach(t=>ScriptApp.deleteTrigger(t));
}

function installObserverTrigger15m() {
  removeObserverTriggers();
  ScriptApp.newTrigger(OBSERVER_V2.triggerFunction).timeBased().everyMinutes(15).create();
  return {
    status:"TRIGGER_INSTALLED",
    trigger_count:ScriptApp.getProjectTriggers()
      .filter(t=>t.getHandlerFunction()===OBSERVER_V2.triggerFunction).length
  };
}

function resetObserverV2StateForLab() {
  PropertiesService.getScriptProperties().deleteProperty(OBSERVER_V2.stateKey);
  return {status:"V2_STATE_RESET"};
}
