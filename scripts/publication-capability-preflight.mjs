import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { googleAccessTokenFromServiceAccountJson } from "../src/google-readonly.mjs";

async function fileCapability(fileId,token) {
  const url=
    "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+
    "?fields=id,name,mimeType,version,modifiedTime,capabilities(canEdit,canDownload)";
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok || body.id!==fileId) throw new Error("Drive capability read failed for "+fileId);
  return {
    id:body.id,
    name:body.name,
    mime_type:body.mimeType,
    version:String(body.version??""),
    modified_time:body.modifiedTime??null,
    can_edit:body.capabilities?.canEdit===true,
    can_download:body.capabilities?.canDownload===true
  };
}

const databaseId=String(process.env.SOSL_DATABASE_ID||"gil-main").trim();
const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);
const plan=await discoverExecutionPlan(token);
const db=plan.databases.find(x=>x.database_id===databaseId);
if(!db) throw new Error("database not found: "+databaseId);

const [snapshot,manifest]=await Promise.all([
  fileCapability(db.snapshot_drive_file_id,token),
  fileCapability(db.manifest_spreadsheet_id,token)
]);

if(!snapshot.can_edit) throw new Error("SNAPSHOT_WRITE_CAPABILITY_MISSING");
if(!manifest.can_edit) throw new Error("MANIFEST_WRITE_CAPABILITY_MISSING");

console.log(JSON.stringify({
  contract:"sosl_publication_capability_preflight_v0.1.0",
  ok:true,
  database_id:databaseId,
  snapshot,
  manifest,
  mutation_attempted:false
},null,2));
