import { appendFile, writeFile } from "node:fs/promises";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import {
  googleAccessTokenFromServiceAccountJson,
  driveFileMeta
} from "../src/google-readonly.mjs";

const databaseId=String(process.env.SOSL_DATABASE_ID||"gil-main").trim();
const output=String(process.env.SOSL_SNAPSHOT_DOWNLOAD_PATH||"work/snapshot-bundle.zip").trim();
const reportOut=String(process.env.SOSL_DOWNLOAD_REPORT||"").trim();

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

const before=await driveFileMeta(database.snapshot_drive_file_id,token);
const r=await fetch(
  "https://www.googleapis.com/drive/v3/files/"+
  encodeURIComponent(database.snapshot_drive_file_id)+
  "?alt=media&supportsAllDrives=true",
  {headers:{authorization:"Bearer "+token}}
);
if(!r.ok) throw new Error("snapshot download failed: "+r.status);
const bytes=new Uint8Array(await r.arrayBuffer());
await writeFile(output,bytes);
const after=await driveFileMeta(database.snapshot_drive_file_id,token);
if(String(before.version)!==String(after.version)){
  throw new Error(
    "SNAPSHOT_CHANGED_DURING_DOWNLOAD before="+String(before.version)+
    " after="+String(after.version)
  );
}
const result={
  contract:"sosl_stable_snapshot_download_v0.1.0",
  ok:true,
  database_id:databaseId,
  drive_file_id:database.snapshot_drive_file_id,
  version:String(after.version),
  size_bytes:bytes.length,
  modified_time:after.modifiedTime??null
};
if(process.env.GITHUB_ENV){
  await appendFile(
    process.env.GITHUB_ENV,
    "SOSL_BASE_SNAPSHOT_VERSION="+String(after.version)+"\n"+
    "SOSL_SNAPSHOT_DRIVE_FILE_ID="+database.snapshot_drive_file_id+"\n",
    "utf8"
  );
}
if(reportOut) await writeFile(reportOut,JSON.stringify(result,null,2)+"\n","utf8");
console.log(JSON.stringify(result,null,2));
