import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import {
  googleAccessTokenFromServiceAccountJson,
  googleFetchWithRetry,
  readSheetValues,
  driveFileMeta
} from "../src/google-readonly.mjs";
import { loadLiveKrg1 } from "../src/live-krg1.mjs";
import { buildLocalManifest, writeManifestAtomic } from "../src/local-manifest.mjs";
import { readKrg1DerivedControlState } from "../src/krg1-control-plane-local.mjs";

function sha(bytes){return createHash("sha256").update(bytes).digest("hex");}
function kv(values){
  const out={};
  for(const row of values??[]){
    if(row?.[0]&&row[0]!=="campo") out[String(row[0])]=row[1]??"";
  }
  return out;
}
async function downloadBytes(fileId,token){
  const url="https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+"?alt=media&supportsAllDrives=true";
  const r=await googleFetchWithRetry(url,{headers:{authorization:"Bearer "+token}});
  if(!r.ok) throw new Error("SNAPSHOT_READBACK_DOWNLOAD_FAILED "+r.status);
  return new Uint8Array(await r.arrayBuffer());
}

const databaseId=String(process.env.SOSL_DATABASE_ID||"gil-main").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
const bundlePath=String(process.env.SOSL_CURRENT_BUNDLE_PATH||"").trim();
const innerZipPath=String(process.env.SOSL_INNER_ZIP_PATH||"").trim();
const metaPath=String(process.env.SOSL_SNAPSHOT_META_PATH||"").trim();
if(!dbPath||!bundlePath||!innerZipPath||!metaPath){
  throw new Error("SOSL_SQLITE_PATH, SOSL_CURRENT_BUNDLE_PATH, SOSL_INNER_ZIP_PATH and SOSL_SNAPSHOT_META_PATH required");
}

const [bundle,innerZip,metaText]=await Promise.all([
  readFile(bundlePath),
  readFile(innerZipPath),
  readFile(metaPath,"utf8")
]);
const meta=JSON.parse(metaText);
const dbBytes=await readFile(dbPath);
if(sha(innerZip)!==String(meta.zip_sha256)) throw new Error("CURRENT_INNER_ZIP_HASH_MISMATCH");
if(sha(dbBytes)!==String(meta.sqlite_sha256)) throw new Error("CURRENT_SQLITE_HASH_MISMATCH");

const db=new DatabaseSync(dbPath,{readOnly:true});
try{
  const integrity=String(db.prepare("PRAGMA integrity_check").get().integrity_check);
  const fk=db.prepare("PRAGMA foreign_key_check").all().length;
  if(integrity!=="ok"||fk!==0) throw new Error("CURRENT_SQLITE_INTEGRITY_FAILED");
}finally{db.close();}

const packageHash=sha(bundle);
const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  ["https://www.googleapis.com/auth/drive","https://www.googleapis.com/auth/spreadsheets"]
);
const plan=await discoverExecutionPlan(token);
const database=plan.databases.find(x=>x.database_id===databaseId);
if(!database) throw new Error("database not found: "+databaseId);

const liveKrg1=await loadLiveKrg1({
  spreadsheetId:database.registry_spreadsheet_id,
  accessToken:token
});
const controlState=readKrg1DerivedControlState({dbPath});
if(!controlState) throw new Error("KRG1_DERIVED_CONTROL_STATE_MISSING");
if(String(controlState.processed_revision)!==String(liveKrg1.revision)){
  throw new Error("CURRENT_SNAPSHOT_KRG1_NOT_CURRENT");
}

let stable=await driveFileMeta(database.snapshot_drive_file_id,token);
const liveBytes=await downloadBytes(database.snapshot_drive_file_id,token);
if(liveBytes.length!==bundle.length||sha(liveBytes)!==packageHash){
  throw new Error("CURRENT_STABLE_BYTES_CHANGED_BEFORE_ACK");
}

const publishedAt=new Date().toISOString();
let finalGlobal=null;
let converged=false;
for(let attempt=1;attempt<=4;attempt++){
  const liveNow=await loadLiveKrg1({
    spreadsheetId:database.registry_spreadsheet_id,
    accessToken:token
  });
  if(String(controlState.processed_revision)!==String(liveNow.revision)){
    throw new Error("KRG1_CHANGED_DURING_CURRENT_SNAPSHOT_ACK");
  }

  const snapshot={
    drive_file_id:database.snapshot_drive_file_id,
    drive_version:String(stable.version),
    generated_at:String(meta.generated_at??""),
    published_at:publishedAt,
    package_size_bytes:bundle.length,
    package_sha256:packageHash,
    inner_zip_size_bytes:innerZip.length,
    inner_zip_sha256:String(meta.zip_sha256??""),
    sqlite_size_bytes:dbBytes.length,
    sqlite_sha256:String(meta.sqlite_sha256??""),
    integrity_check:String(meta.integrity_check??""),
    counts:meta.counts??{}
  };
  const manifest=await buildLocalManifest({
    dbPath,
    intent:liveNow.intent,
    liveKrg1Revision:liveNow.revision,
    driveToken:token,
    snapshot
  });
  if(manifest.has_material_delta||manifest.has_fatal_state){
    throw new Error("CURRENT_SNAPSHOT_MANIFEST_NOT_CLEAN "+JSON.stringify({
      sync_counts:manifest.sync_counts,
      fatal_states:manifest.fatal_states
    }));
  }
  await writeManifestAtomic({
    spreadsheetId:database.manifest_spreadsheet_id,
    manifest,
    accessToken:token
  });
  finalGlobal=kv(await readSheetValues(
    database.manifest_spreadsheet_id,
    "ESTADO_GLOBAL!A1:D100",
    token
  ));
  if(String(finalGlobal.snapshot_package_sha256)!==packageHash) throw new Error("ACK_MANIFEST_HASH_MISMATCH");
  if(String(finalGlobal.snapshot_version)!==String(stable.version)) throw new Error("ACK_MANIFEST_VERSION_MISMATCH");
  if(String(finalGlobal.snapshot_status)!=="PUBLISHED_CURRENT") throw new Error("ACK_MANIFEST_NOT_CURRENT");

  const after=await driveFileMeta(database.snapshot_drive_file_id,token);
  if(String(after.version)===String(stable.version)){
    stable=after;
    converged=true;
    break;
  }
  const bytesNow=await downloadBytes(database.snapshot_drive_file_id,token);
  if(bytesNow.length!==bundle.length||sha(bytesNow)!==packageHash){
    throw new Error("CURRENT_STABLE_CONTENT_CHANGED_DURING_ACK");
  }
  stable=after;
}
if(!converged) throw new Error("CURRENT_STABLE_VERSION_DID_NOT_CONVERGE");

console.log(JSON.stringify({
  contract:"sosl_current_snapshot_ack_v0.1.0",
  ok:true,
  database_id:databaseId,
  stable_version:String(stable.version),
  package_sha256:packageHash,
  package_size_bytes:bundle.length,
  krg1_revision:String(controlState.processed_revision),
  snapshot_status:String(finalGlobal.snapshot_status),
  publication_attempted:false,
  manifest_write_attempted:true
},null,2));
