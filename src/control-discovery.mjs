const CONTROL_TITLE = "GIL_SQLITE_CONTROLE_EXECUCAO";

function rowsToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const [header, ...rows] = values;
  return rows
    .filter(row => row.some(v => String(v ?? "").trim() !== ""))
    .map(row => Object.fromEntries(
      header.map((key, i) => [String(key ?? "").trim(), row[i] ?? ""])
    ));
}

function kvRows(values) {
  const out = {};
  for (const row of values ?? []) {
    if (row?.[0] && row[0] !== "campo") out[String(row[0])] = row[1] ?? "";
  }
  return out;
}

async function jsonFetch(url, accessToken) {
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + accessToken }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("readonly Google request failed: " + response.status);
  }
  return body;
}

async function findControlSpreadsheet(accessToken) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set(
    "q",
    [
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
      "name = '" + CONTROL_TITLE.replaceAll("'", "\\'") + "'"
    ].join(" and ")
  );
  url.searchParams.set("fields", "files(id,name,mimeType)");
  const body = await jsonFetch(url, accessToken);
  const matches = Array.isArray(body.files) ? body.files : [];
  if (matches.length !== 1) {
    throw new Error("control spreadsheet discovery expected exactly one match");
  }
  return matches[0].id;
}

async function sheetValues(spreadsheetId, range, accessToken) {
  const url =
    "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(spreadsheetId) +
    "/values/" +
    encodeURIComponent(range) +
    "?majorDimension=ROWS";
  const body = await jsonFetch(url, accessToken);
  return body.values ?? [];
}

function eligibleSource(row) {
  return (
    String(row.desired_presence) === "PRESENT" &&
    String(row.state) === "ACTIVE" &&
    String(row.body_present) === "1" &&
    String(row.estado_sync) === "OK"
  );
}

export async function discoverExecutionPlan(accessToken) {
  if (!accessToken) throw new Error("access token required");

  const controlId = await findControlSpreadsheet(accessToken);
  const [globalValues, databaseValues, executorValues] = await Promise.all([
    sheetValues(controlId, "GLOBAL!A1:B100", accessToken),
    sheetValues(controlId, "DATABASES!A1:P200", accessToken),
    sheetValues(controlId, "EXECUTORS!A1:L100", accessToken)
  ]);

  const global = kvRows(globalValues);
  const databases = rowsToObjects(databaseValues);
  const executors = rowsToObjects(executorValues);

  if (global.control_version !== "v0.1") {
    throw new Error("unsupported control version");
  }

  const enabledDatabases = databases
    .filter(row => String(row.enabled).toUpperCase() === "TRUE")
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
    .slice(0, Number(global.max_databases_per_run || 8));

  const plans = [];
  for (const db of enabledDatabases) {
    if (!db.manifest_spreadsheet_id) {
      throw new Error("enabled database without manifest id");
    }

    const [stateValues, sourceValues] = await Promise.all([
      sheetValues(db.manifest_spreadsheet_id, "ESTADO_GLOBAL!A1:D100", accessToken),
      sheetValues(db.manifest_spreadsheet_id, "FONTES!A1:P1000", accessToken)
    ]);

    const manifestState = kvRows(stateValues);
    const sourceRows = rowsToObjects(sourceValues);
    const eligible = sourceRows.filter(eligibleSource);

    plans.push({
      database_id: db.database_id,
      publication_mode: db.publication_mode,
      reader_contract: db.reader_contract,
      corpus_scope: db.corpus_scope,
      manifest_version: manifestState.manifest_version ?? null,
      snapshot_status: manifestState.snapshot_status ?? null,
      eligible_source_count: eligible.length,
      source_count_total: sourceRows.length,
      eligible_sources: eligible.map(row => ({
        code: row.codigo_logico,
        drive_file_id: row.drive_file_id,
        drive_revision: row.drive_revision
      }))
    });
  }

  return {
    contract: "sosl_execution_control_discovery_v0.1.0",
    control: {
      observer_enabled: global.observer_enabled,
      observer_mode: global.observer_mode,
      dispatch_enabled: global.dispatch_enabled,
      active_executor: global.active_executor,
      executor_provider: global.executor_provider,
      reader_contract: global.reader_contract,
      max_databases_per_run: Number(global.max_databases_per_run || 8)
    },
    executor_candidates: executors.map(row => ({
      executor_id: row.executor_id,
      enabled: row.enabled,
      kind: row.kind,
      role: row.role,
      state: row.state
    })),
    databases: plans
  };
}
