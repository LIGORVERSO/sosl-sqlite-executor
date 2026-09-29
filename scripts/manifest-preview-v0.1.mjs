import { writeFile } from "node:fs/promises";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { googleAccessTokenFromServiceAccountJson } from "../src/google-readonly.mjs";
import { loadLiveKrg1 } from "../src/live-krg1.mjs";
import { buildLocalManifest } from "../src/local-manifest.mjs";

const databaseId=String(process.env.SOSL_DATABASE_ID||"gil-main").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!dbPath) throw new Error("SOSL_SQLITE_PATH required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);
const plan=await discoverExecutionPlan(token);
const database=plan.databases.find(x=>x.database_id===databaseId);
if(!database) throw new Error("database not found: "+databaseId);

const liveKrg1=await loadLiveKrg1({
  spreadsheetId:database.registry_spreadsheet_id,
  accessToken:token
});
const manifest=await buildLocalManifest({
  dbPath,
  intent:liveKrg1.intent,
  liveKrg1Revision:liveKrg1.revision,
  driveToken:token
});
const reportPath=String(process.env.SOSL_MANIFEST_REPORT||"").trim();
if(reportPath) await writeFile(reportPath,JSON.stringify(manifest,null,2)+"\n","utf8");
console.log(JSON.stringify({
  contract:manifest.contract,
  generated_at:manifest.generated_at,
  has_material_delta:manifest.has_material_delta,
  live_krg1_revision:manifest.live_krg1_revision,
  processed_krg1_revision:manifest.processed_krg1_revision,
  sync_counts:manifest.sync_counts,
  source_rows:manifest.source_values.length-1,
  drive_write_attempted:false,
  manifest_write_attempted:false
},null,2));
