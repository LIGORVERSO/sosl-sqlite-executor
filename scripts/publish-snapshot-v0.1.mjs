import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import {
  googleAccessTokenFromServiceAccountJson,
  readSheetValues,
  driveFileMeta
} from "../src/google-readonly.mjs";
import { loadLiveKrg1 } from "../src/live-krg1.mjs";
import { buildLocalManifest, writeManifestAtomic } from "../src/local-manifest.mjs";
import { readKrg1DerivedControlState } from "../src/krg1-control-plane-local.mjs";

function hash(bytes){
  return createHash("sha256").update(bytes).digest("hex");
}
function kv(values){
  const out={};
  for(const row of values??[]){
    if(row?.[0]&&row[0]!=="campo") out[String(row[0])]=row[1]??"";
  }
  return out;
}
async function uploadStable({fileId,bytes,token}){
  const url=
    "https://www.googleapis.com/upload/drive/v3/files/"+
    encodeURIComponent(fileId)+
    "?uploadType=media&supportsAllDrives=true&fields=id,name,version,modifiedTime,size,md5Checksum";
  const r=await fetch(url,{
    method:"PATCH",
    headers:{
      authorization:"Bearer "+token,
      "content-type":"application/zip"
    },
    body:bytes
  });
  const body=await r.json().catch(()=>({}));
  if(!r.ok||body.id!==fileId||!body.version){
    throw new Error("SNAPSHOT_UPLOAD_FAILED "+r.status+" "+JSON.stringify(body));
  }
  return body;
}
async function downloadBytes(fileId,token){
  const url=
    "https://www.googleapis.com/drive/v3/files/"+
    encodeURIComponent(fileId)+
    "?alt=media&supportsAllDrives=true";
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  if(!r.ok) throw new Error("SNAPSHOT_READBACK_DOWNLOAD_FAILED "+r.status);
  return new Uint8Array(await r.arrayBuffer());
}

const mode=String(process.env.SOSL_PUBLISH_MODE||"DRY_RUN").trim().toUpperCase();
if(!["DRY_RUN","COMMIT"].includes(mode)) throw new Error("SOSL_PUBLISH_MODE unsupported");
const databaseId=String(process.env.SOSL_DATABASE_ID||"gil-main").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
const bundlePath=String(process.env.SOSL_BUNDLE_PATH||"").trim();
const buildReportPath=String(process.env.SOSL_BUILD_REPORT||"").trim();
const reportOut=String(process.env.SOSL_PUBLISH_REPORT||"").trim();
const expectedBaseVersion=String(process.env.SOSL_BASE_SNAPSHOT_VERSION||"").trim();
if(!dbPath||!bundlePath||!buildReportPath){
  throw new Error("SOSL_SQLITE_PATH, SOSL_BUNDLE_PATH and SOSL_BUILD_REPORT required");
}

const [bytes,buildReport]=await Promise.all([
  readFile(bundlePath),
  readFile(buildReportPath,"utf8").then(JSON.parse)
]);
const packageHash=hash(bytes);
if(packageHash!==String(buildReport.outer_sha256)){
  throw new Error("PUBLISH_INPUT_SHA256_MISMATCH");
}
if(bytes.length!==Number(buildReport.outer_size_bytes)){
  throw new Error("PUBLISH_INPUT_SIZE_MISMATCH");
}
if(String(buildReport?.meta?.integrity_check)!=="ok"){
  throw new Error("PUBLISH_INPUT_INTEGRITY_NOT_OK");
}
if(Number(buildReport?.meta?.foreign_key_violations??-1)!==0){
  throw new Error("PUBLISH_INPUT_FOREIGN_KEYS_NOT_OK");
}

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets"
  ]
);
const plan=await discoverExecutionPlan(token);
const database=plan.databases.find(x=>x.database_id===databaseId);
if(!database) throw new Error("database not found: "+databaseId);

const liveBefore=await loadLiveKrg1({
  spreadsheetId:database.registry_spreadsheet_id,
  accessToken:token
});
const controlState=readKrg1DerivedControlState({dbPath});
if(!controlState) throw new Error("KRG1_DERIVED_CONTROL_STATE_MISSING");
if(String(controlState.processed_revision)!==liveBefore.revision){
  throw new Error("KRG1_CHANGED_AFTER_LOCAL_BUILD");
}
const preview=await buildLocalManifest({
  dbPath,
  intent:liveBefore.intent,
  liveKrg1Revision:liveBefore.revision,
  driveToken:token
});
if(preview.has_fatal_state){
  throw new Error("LOCAL_CANDIDATE_HAS_FATAL_STATE "+JSON.stringify(preview.fatal_states));
}

const stableBefore=await driveFileMeta(database.snapshot_drive_file_id,token);
if(!expectedBaseVersion){
  throw new Error("SOSL_BASE_SNAPSHOT_VERSION required");
}
if(String(stableBefore.version)!==expectedBaseVersion){
  throw new Error(
    "SNAPSHOT_BASE_VERSION_CHANGED expected="+expectedBaseVersion+
    " actual="+String(stableBefore.version)
  );
}
const baseReport={
  contract:"sosl_snapshot_publisher_v0.1.0",
  mode,
  database_id:databaseId,
  snapshot_drive_file_id:database.snapshot_drive_file_id,
  manifest_spreadsheet_id:database.manifest_spreadsheet_id,
  local_package_sha256:packageHash,
  local_package_size_bytes:bytes.length,
  krg1_processed_revision:String(controlState.processed_revision),
  stable_before_version:String(stableBefore.version),
  expected_base_version:expectedBaseVersion,
  mutation_attempted:false
};

if(mode==="DRY_RUN"){
  const out={...baseReport,ok:true,publication_attempted:false,manifest_write_attempted:false};
  if(reportOut) await writeFile(reportOut,JSON.stringify(out,null,2)+"\n","utf8");
  console.log(JSON.stringify(out,null,2));
  process.exit(0);
}

baseReport.mutation_attempted=true;
const uploaded=await uploadStable({
  fileId:database.snapshot_drive_file_id,
  bytes,
  token
});
if(String(uploaded.version)===String(stableBefore.version)){
  throw new Error("SNAPSHOT_DRIVE_VERSION_DID_NOT_ADVANCE");
}

const readback=await downloadBytes(database.snapshot_drive_file_id,token);
const readbackHash=hash(readback);
if(readback.length!==bytes.length||readbackHash!==packageHash){
  throw new Error("SNAPSHOT_READBACK_BYTES_MISMATCH");
}
const stableAfterReadback=await driveFileMeta(database.snapshot_drive_file_id,token);
if(String(stableAfterReadback.version)!==String(uploaded.version)){
  throw new Error("SNAPSHOT_VERSION_CHANGED_DURING_READBACK");
}

const liveAfterUpload=await loadLiveKrg1({
  spreadsheetId:database.registry_spreadsheet_id,
  accessToken:token
});
const publishedAt=new Date().toISOString();
const meta=buildReport.meta??{};
const snapshotInfo={
  drive_file_id:database.snapshot_drive_file_id,
  drive_version:String(stableAfterReadback.version),
  generated_at:String(meta.generated_at??""),
  published_at:publishedAt,
  package_size_bytes:bytes.length,
  package_sha256:packageHash,
  inner_zip_size_bytes:Number(meta.zip_size_bytes??0),
  inner_zip_sha256:String(meta.zip_sha256??""),
  sqlite_size_bytes:Number(meta.sqlite_size_bytes??0),
  sqlite_sha256:String(meta.sqlite_sha256??""),
  integrity_check:String(meta.integrity_check??""),
  counts:meta.counts??{}
};
const manifest=await buildLocalManifest({
  dbPath,
  intent:liveAfterUpload.intent,
  liveKrg1Revision:liveAfterUpload.revision,
  driveToken:token,
  snapshot:snapshotInfo
});
await writeManifestAtomic({
  spreadsheetId:database.manifest_spreadsheet_id,
  manifest,
  accessToken:token
});

const globalReadback=kv(await readSheetValues(
  database.manifest_spreadsheet_id,
  "ESTADO_GLOBAL!A1:D100",
  token
));
if(String(globalReadback.snapshot_package_sha256)!==packageHash){
  throw new Error("MANIFEST_READBACK_PACKAGE_HASH_MISMATCH");
}
if(String(globalReadback.snapshot_version)!==String(stableAfterReadback.version)){
  throw new Error("MANIFEST_READBACK_DRIVE_VERSION_MISMATCH");
}
if(String(globalReadback.snapshot_krg1_membership_revision)!==String(controlState.processed_revision)){
  throw new Error("MANIFEST_READBACK_KRG1_REVISION_MISMATCH");
}
if(!["PUBLISHED_CURRENT","DIRTY"].includes(String(globalReadback.snapshot_status))){
  throw new Error("MANIFEST_READBACK_STATUS_INVALID");
}

const stableFinal=await driveFileMeta(database.snapshot_drive_file_id,token);
if(String(stableFinal.version)!==String(stableAfterReadback.version)){
  const dirtyManifest=structuredClone(manifest);
  const statusRow=dirtyManifest.global_values.find(r=>r?.[0]==="snapshot_status");
  if(statusRow){
    statusRow[1]="DIRTY";
    statusRow[2]="DELTA";
    statusRow[3]="Snapshot Drive mudou durante o commit do manifesto; novo ciclo obrigatório.";
  }
  await writeManifestAtomic({
    spreadsheetId:database.manifest_spreadsheet_id,
    manifest:dirtyManifest,
    accessToken:token
  });
  throw new Error("SNAPSHOT_VERSION_CHANGED_AFTER_MANIFEST");
}

const out={
  ...baseReport,
  ok:true,
  publication_attempted:true,
  manifest_write_attempted:true,
  stable_after_version:String(stableFinal.version),
  readback_sha256:readbackHash,
  manifest_snapshot_status:String(globalReadback.snapshot_status),
  live_krg1_after_upload:liveAfterUpload.revision,
  snapshot_krg1_membership_revision:String(controlState.processed_revision),
  published_at:publishedAt
};
if(reportOut) await writeFile(reportOut,JSON.stringify(out,null,2)+"\n","utf8");
console.log(JSON.stringify(out,null,2));
