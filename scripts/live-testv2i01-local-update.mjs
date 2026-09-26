import { createSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { observeStyledDocumentWithToken } from "../src/structured-doc-source.mjs";
import { buildV1CompatibleParagraphModel } from "../src/v1-compatible-doc-model.mjs";
import { applySourceDeltaLocal } from "../src/local-v2-updater-core.mjs";

const CODE = "TESTV2I01";
const FILE_ID = "1P58vwW4L7zytIYRu-Q2Cwcg2yh32EZBY7WC4g7DEnz8";
const dbPath = process.env.SOSL_TEST_SQLITE;
if (!dbPath) throw new Error("SOSL_TEST_SQLITE required");

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
const credential = JSON.parse(raw);

const b64url = value => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
const scopes = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents.readonly"
];
const claims = b64url(JSON.stringify({
  iss: credential.client_email,
  scope: scopes.join(" "),
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 3600
}));
const unsigned = `${header}.${claims}`;
const signer = createSign("RSA-SHA256");
signer.update(unsigned);
signer.end();
const assertion = `${unsigned}.${signer.sign(credential.private_key).toString("base64url")}`;

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method:"POST",
  headers:{"content-type":"application/x-www-form-urlencoded"},
  body:new URLSearchParams({
    grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  })
});
const tokenBody = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok || !tokenBody.access_token) throw new Error("readonly token failed");

const db = new DatabaseSync(dbPath);
const source = db.prepare(`
  SELECT s.source_id,s.title,s.mime_type,s.drive_file_id,
         ss.last_processed_revision
  FROM v2_source_objects s
  JOIN v2_sync_state ss ON ss.source_id=s.source_id
  WHERE s.sosl_code=? AND s.active=1
`).get(CODE);
if (!source) throw new Error("TESTV2I01 missing from snapshot");

const metadataRow = db.prepare(`
  SELECT stable_ref,content_text,content_hash,provenance_locator
  FROM v2_content_units
  WHERE source_id=? AND active=1 AND unit_type='source_metadata'
`).get(source.source_id);
if (!metadataRow) throw new Error("source_metadata missing");

const baselineRevision = source.last_processed_revision;
db.close();

const observed = await observeStyledDocumentWithToken({
  source: {
    sosl_code: CODE,
    drive_file_id: FILE_ID
  },
  accessToken: tokenBody.access_token
});
const observedRevision = "drive-version:" + observed.version;

const model = buildV1CompatibleParagraphModel(observed.paragraphs, CODE);

const desiredUnits = [
  {
    stable_ref: metadataRow.stable_ref,
    unit_type: "source_metadata",
    position_ordinal: 0,
    heading_path: null,
    content_text: metadataRow.content_text,
    content_hash: metadataRow.content_hash,
    provenance_locator: metadataRow.provenance_locator
  },
  ...model.items.map((item, index) => ({
    stable_ref: item.stable_ref,
    unit_type: item.kind,
    position_ordinal: index + 1,
    heading_path: item.section,
    content_text: item.text,
    content_hash: item.content_hash,
    provenance_locator:
      "drive:" + FILE_ID +
      ";start:" + (item.startIndex ?? "") +
      ";end:" + (item.endIndex ?? "")
  }))
];

const result = applySourceDeltaLocal({
  dbPath,
  code: CODE,
  expectedBaselineRevision: baselineRevision,
  observedRevision,
  sourceHash: model.hash,
  desiredUnits,
  title: observed.title,
  mimeType: observed.mime_type
});

console.log(JSON.stringify({
  stage:"live_testv2i01_local_update",
  baseline_revision: baselineRevision,
  observed_revision: observedRevision,
  observed_units: model.items.length,
  ...result,
  drive_write_attempted:false,
  snapshot_publish_attempted:false
}, null, 2));
