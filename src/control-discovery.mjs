function rowsToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return [];

  const [header, ...rows] = values;

  return rows
    .filter(row =>
      row.some(v => String(v ?? "").trim() !== "")
    )
    .map(row =>
      Object.fromEntries(
        header.map((key, i) => [
          String(key ?? "").trim(),
          row[i] ?? ""
        ])
      )
    );
}

function kvRows(values) {
  const out = {};

  for (const row of values ?? []) {
    if (row?.[0] && row[0] !== "campo") {
      out[String(row[0])] = row[1] ?? "";
    }
  }

  return out;
}

async function jsonFetch(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      authorization: "Bearer " + accessToken
    }
  });

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      "readonly Google request failed: " +
      response.status
    );
  }

  return body;
}

async function sheetValues(
  spreadsheetId,
  range,
  accessToken
) {
  const url =
    "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(spreadsheetId) +
    "/values/" +
    encodeURIComponent(range) +
    "?majorDimension=ROWS";

  const body =
    await jsonFetch(url, accessToken);

  return body.values ?? [];
}

function classifySource(row) {
  const desired = String(row.desired_presence ?? "");
  const state = String(row.state ?? "");
  const body = String(row.body_present ?? "");
  const sync = String(row.estado_sync ?? "");
  const name = String(row.nome_drive ?? "");

  if (
    desired === "PRESENT" &&
    state === "ACTIVE" &&
    body === "1" &&
    sync === "OK"
  ) return "OPERATIONAL";

  if (
    desired === "PRESENT" &&
    state === "INACTIVE" &&
    body === "1" &&
    sync === "CONGELADO_OK"
  ) return "FROZEN_TEST";

  if (
    desired === "ABSENT" &&
    state === "INACTIVE" &&
    body === "1" &&
    sync === "RETIRADA_PENDENTE_CORPO" &&
    name.startsWith("RETIRAR_")
  ) return "ARCHIVED_RETIREMENT_AUTHORIZED";

  if (
    String(row.codigo_logico) === "KRG1" &&
    desired === "ABSENT" &&
    body === "0"
  ) return "CONTROL_PLANE_EXTERNAL";

  return "NON_OPERATIONAL";
}

export async function discoverExecutionPlan(
  accessToken
) {
  if (!accessToken) {
    throw new Error("access token required");
  }

  const controlId =
    "1G1O2cjMRGxwn3d1t2NjBo93c20dX84G5dH_uMLA46Pw";

  const [
    globalValues,
    databaseValues,
    executorValues
  ] = await Promise.all([
    sheetValues(
      controlId,
      "GLOBAL!A1:B100",
      accessToken
    ),
    sheetValues(
      controlId,
      "DATABASES!A1:P200",
      accessToken
    ),
    sheetValues(
      controlId,
      "EXECUTORS!A1:L100",
      accessToken
    )
  ]);

  const global =
    kvRows(globalValues);

  const databases =
    rowsToObjects(databaseValues);

  const executors =
    rowsToObjects(executorValues);

  if (global.control_version !== "v0.1") {
    throw new Error(
      "unsupported control version"
    );
  }

  const enabledDatabases =
    databases
      .filter(
        row =>
          String(row.enabled)
            .toUpperCase() === "TRUE"
      )
      .sort(
        (a, b) =>
          Number(b.priority || 0) -
          Number(a.priority || 0)
      )
      .slice(
        0,
        Number(
          global.max_databases_per_run || 8
        )
      );

  const plans = [];

  for (const db of enabledDatabases) {
    if (!db.manifest_spreadsheet_id) {
      throw new Error(
        "enabled database without manifest id"
      );
    }

    const [
      stateValues,
      sourceValues
    ] = await Promise.all([
      sheetValues(
        db.manifest_spreadsheet_id,
        "ESTADO_GLOBAL!A1:D100",
        accessToken
      ),
      sheetValues(
        db.manifest_spreadsheet_id,
        "FONTES!A1:P1000",
        accessToken
      )
    ]);

    const manifestState =
      kvRows(stateValues);

    const sourceRows =
      rowsToObjects(sourceValues);

    const classified =
      sourceRows.map(row => ({
        ...row,
        execution_class:
          classifySource(row)
      }));

    const operational =
      classified.filter(
        row =>
          row.execution_class ===
          "OPERATIONAL"
      );

    const frozen =
      classified.filter(
        row =>
          row.execution_class ===
          "FROZEN_TEST"
      );

    const retirement =
      classified.filter(
        row =>
          row.execution_class ===
          "ARCHIVED_RETIREMENT_AUTHORIZED"
      );

    const controlPlane =
      classified.filter(
        row =>
          row.execution_class ===
          "CONTROL_PLANE_EXTERNAL"
      );

    plans.push({
      database_id:
        db.database_id,

      snapshot_drive_file_id:
        db.snapshot_drive_file_id,

      manifest_spreadsheet_id:
        db.manifest_spreadsheet_id,

      registry_spreadsheet_id:
        db.registry_spreadsheet_id,

      publication_mode:
        db.publication_mode,

      reader_contract:
        db.reader_contract,

      corpus_scope:
        db.corpus_scope,

      manifest_version:
        manifestState.manifest_version ??
        null,

      snapshot_status:
        manifestState.snapshot_status ??
        null,

      eligible_source_count:
        operational.length,

      operational_source_count:
        operational.length,

      frozen_source_count:
        frozen.length,

      retirement_source_count:
        retirement.length,

      control_plane_external_count:
        controlPlane.length,

      source_count_total:
        sourceRows.length,

      operational_sources:
        operational.map(row => ({
          code:
            row.codigo_logico,

          drive_file_id:
            row.drive_file_id,

          drive_revision:
            row.drive_revision
        })),

      frozen_sources:
        frozen.map(row => ({
          code:
            row.codigo_logico,

          drive_file_id:
            row.drive_file_id,

          drive_revision:
            row.drive_revision
        })),

      retirement_sources:
        retirement.map(row => ({
          code:
            row.codigo_logico,

          drive_file_id:
            row.drive_file_id,

          drive_revision:
            row.drive_revision
        })),

      control_plane_external:
        controlPlane.map(row => ({
          code:
            row.codigo_logico,

          drive_file_id:
            row.drive_file_id,

          drive_revision:
            row.drive_revision
        }))
    });
  }

  return {
    contract:
      "sosl_execution_control_discovery_v0.1.0",

    control: {
      observer_enabled:
        global.observer_enabled,

      observer_mode:
        global.observer_mode,

      dispatch_enabled:
        global.dispatch_enabled,

      active_executor:
        global.active_executor,

      executor_provider:
        global.executor_provider,

      reader_contract:
        global.reader_contract,

      max_databases_per_run:
        Number(
          global.max_databases_per_run || 8
        )
    },

    executor_candidates:
      executors.map(row => ({
        executor_id:
          row.executor_id,

        enabled:
          row.enabled,

        kind:
          row.kind,

        role:
          row.role,

        state:
          row.state
      })),

    databases:
      plans
  };
}
