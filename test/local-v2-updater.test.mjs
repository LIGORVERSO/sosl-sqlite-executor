import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applySourceDeltaLocal } from "../src/local-v2-updater-core.mjs";

const sourceDb = process.env.SOSL_TEST_SQLITE;
if (!sourceDb) throw new Error("SOSL_TEST_SQLITE required");

const dir = mkdtempSync(join(tmpdir(), "sosl-local-updater-"));
const dbPath = join(dir, "test.db");
copyFileSync(sourceDb, dbPath);

try {
  const db = new DatabaseSync(dbPath);
  const source = db.prepare(
    "SELECT source_id FROM v2_source_objects WHERE sosl_code='TESTV2I01'"
  ).get();
  if (!source) throw new Error("TESTV2I01 missing");

  const revision = db.prepare(
    "SELECT last_processed_revision FROM v2_sync_state WHERE source_id=?"
  ).get(source.source_id).last_processed_revision;

  const rows = db.prepare(`
    SELECT stable_ref,unit_type,position_ordinal,heading_path,
           content_text,content_hash,provenance_locator
    FROM v2_content_units
    WHERE source_id=? AND active=1
    ORDER BY position_ordinal,content_pk
  `).all(source.source_id);
  db.close();

  const desired = rows.map(row => ({...row}));
  const target = desired.find(
    row => row.stable_ref === "TESTV2I01:section:004"
  );
  if (!target) throw new Error("fixture target missing");

  target.content_text = "UNIDADE: ALFA — LOCAL SQLITE DELTA PROBE";
  target.content_hash = createHash("sha256")
    .update(target.content_text)
    .digest("hex");

  const removeIndex = desired.findIndex(
    row => row.stable_ref === "TESTV2I01:section:005"
  );
  if (removeIndex < 0) throw new Error("fixture removal target missing");
  desired.splice(removeIndex, 1);

  desired.push({
    stable_ref: "TESTV2I01:section:local-probe",
    unit_type: "paragraph",
    position_ordinal: 999,
    heading_path: "LOCAL PROBE",
    content_text: "LOCAL SQLITE DELTA PROBE NOVA UNIDADE",
    provenance_locator: "probe:local"
  });

  const sourceHash = createHash("sha256")
    .update(JSON.stringify(desired.map(row => [row.stable_ref, row.content_text])))
    .digest("hex");

  const result = applySourceDeltaLocal({
    dbPath,
    code: "TESTV2I01",
    expectedBaselineRevision: revision,
    observedRevision: "drive-version:LOCAL-PROBE-21",
    sourceHash,
    desiredUnits: desired
  });

  if (
    !result.ok ||
    result.mode !== "DELTA_APPLIED" ||
    result.changed !== 1 ||
    result.added !== 1 ||
    result.removed !== 1 ||
    result.active_units !== 28 ||
    result.integrity_check !== "ok" ||
    result.foreign_key_violations !== 0 ||
    result.fts_orphans !== 0
  ) {
    throw new Error("LOCAL_UPDATER_REGRESSION_FAILED " + JSON.stringify(result));
  }

  console.log("LOCAL_V2_UPDATER_TEST_OK", JSON.stringify(result));
} finally {
  rmSync(dir, {recursive:true, force:true});
}
