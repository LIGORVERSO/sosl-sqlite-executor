import { DatabaseSync } from "node:sqlite";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { compileCorpusRegistryIntent } from "../src/corpus-registry.js";
import { planCorpusReconciliation } from "../src/corpus-reconciler.js";
import { applyCorpusRegistryPlanLocal } from "../src/local-registry-apply.mjs";
import { applyKrg1ControlPlaneLocal, readKrg1DerivedControlState } from "../src/krg1-control-plane-local.mjs";
import {
  googleAccessTokenFromServiceAccountJson,
  readSheetValues,
  driveFileMeta
} from "../src/google-readonly.mjs";

const GDOC="application/vnd.google-apps.document";
const GSHEET="application/vnd.google-apps.spreadsheet";
const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function adapterForMime(mime) {
  if (mime===GDOC) return "google_doc_live_v2";
  if (mime===GSHEET) return "google_sheet_rows_live_v2";
  if (mime===DOCX) return "drive_docx_live_v2";
  if (mime===XLSX) return "drive_xlsx_rows_live_v2";
  return null;
}
function sheetRows(values) {
  if (!Array.isArray(values)||values.length<1) return [];
  const headers=(values[0]??[]).map(x=>String(x??"").trim());
  return values.slice(1).map((row,index)=>({
    row_number:index+2,
    cells:Object.fromEntries(headers.map((h,i)=>[h,row?.[i]??""]))
  }));
}
function queryAll(db,sql,...args){return db.prepare(sql).all(...args);}
function counts(actions){
  return actions.reduce((a,x)=>{a[x.kind]=(a[x.kind]??0)+1;return a;},{});
}

const databaseId=String(process.env.SOSL_DATABASE_ID||"").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!databaseId||!dbPath) throw new Error("SOSL_DATABASE_ID and SOSL_SQLITE_PATH required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);
const executionPlan=await discoverExecutionPlan(token);
const database=executionPlan.databases.find(x=>x.database_id===databaseId);
if(!database?.registry_spreadsheet_id) throw new Error("registry spreadsheet unavailable");

const registryMetaBefore=await driveFileMeta(database.registry_spreadsheet_id,token);
const [identityValues,provisionalValues,relationValues]=await Promise.all([
  readSheetValues(database.registry_spreadsheet_id,"IDENTIDADES!A1:T999",token),
  readSheetValues(database.registry_spreadsheet_id,"SUPORTES_PROVISORIOS!A1:R999",token),
  readSheetValues(database.registry_spreadsheet_id,"RELACOES!A1:G999",token)
]);
const registryMetaAfter=await driveFileMeta(database.registry_spreadsheet_id,token);
if(String(registryMetaBefore.version)!==String(registryMetaAfter.version)){
  throw new Error("KRG1_CHANGED_DURING_STRUCTURED_READ");
}
const revision="drive-version:"+String(registryMetaAfter.version);
const identityTab={title:"IDENTIDADES",rows:sheetRows(identityValues)};
const provisionalTab={title:"SUPORTES_PROVISORIOS",rows:sheetRows(provisionalValues)};
const relationTab={title:"RELACOES",rows:sheetRows(relationValues)};
const intent=compileCorpusRegistryIntent({
  sources:[{
    sosl_code:"KRG1",
    revision,
    tabs:[identityTab,provisionalTab,relationTab]
  }]
});
if(intent.invalid_commands.length){
  throw new Error("KRG1_INVALID_COMMANDS "+JSON.stringify(intent.invalid_commands));
}

async function buildPlan(){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {
    const currentRegistry=queryAll(db,`
      SELECT sosl_code,source_id,drive_file_id,adapter,registry_kind,
             desired_presence,state,body_present,membership_source_revision,
             membership_source_locator,updated_at
      FROM corpus_registry ORDER BY sosl_code
    `).map(r=>({
      sosl_code:String(r.sosl_code),source_id:String(r.source_id),
      drive_file_id:String(r.drive_file_id),adapter:String(r.adapter),
      registry_kind:String(r.registry_kind),desired_presence:String(r.desired_presence),
      state:String(r.state),body_present:Number(r.body_present),
      membership_source_revision:String(r.membership_source_revision??""),
      membership_source_locator:String(r.membership_source_locator??""),
      updated_at:String(r.updated_at??"")
    }));

    const currentSources=queryAll(db,`
      SELECT s.source_id,s.sosl_code,s.drive_file_id,s.source_format
      FROM v2_source_objects s
      WHERE s.active=1
        AND (
          s.sosl_code<>'KRG1'
          OR EXISTS(
            SELECT 1 FROM v2_content_units c
            WHERE c.source_id=s.source_id AND c.active=1
          )
        )
      ORDER BY s.sosl_code
    `).map(r=>({
      source_id:String(r.source_id),sosl_code:String(r.sosl_code),
      drive_file_id:String(r.drive_file_id),source_format:String(r.source_format)
    }));

    const registryCodes=new Set(currentRegistry.map(x=>x.sosl_code));
    const sourceCodes=new Set(currentSources.map(x=>x.sosl_code));
    const metadataByCode=new Map();
    for(const entry of intent.entries){
      if(entry.desired_presence!=="PRESENT") continue;
      if(registryCodes.has(entry.sosl_code)||sourceCodes.has(entry.sosl_code)) continue;
      const meta=await driveFileMeta(entry.drive_file_id,token);
      metadataByCode.set(entry.sosl_code,{mime_type:String(meta.mimeType??"")});
    }

    const incomingRelationsByCode=new Map();
    for(const row of currentRegistry){
      if(row.state!=="RETIRING") continue;
      const n=Number(db.prepare(`
        SELECT COUNT(*) AS n FROM v2_condition_links l
        WHERE (l.provenance_source_id IS NULL OR l.provenance_source_id<>?)
          AND (
            l.subject_ref=? OR l.object_ref=? OR
            l.subject_ref LIKE ? OR l.object_ref LIKE ?
          )
      `).get(
        row.source_id,row.sosl_code,row.sosl_code,
        row.sosl_code+":%",row.sosl_code+":%"
      ).n);
      incomingRelationsByCode.set(row.sosl_code,n);
    }

    return planCorpusReconciliation({
      intent,currentRegistry,currentSources,metadataByCode,adapterForMime,
      incomingRelationsByCode
    });
  } finally {
    db.close();
  }
}

const before=await buildPlan();
if(before.diagnostics.length){
  throw new Error("REGISTRY_DIAGNOSTICS_BLOCK_APPLY "+JSON.stringify(before.diagnostics));
}
const applied=applyCorpusRegistryPlanLocal({dbPath,reconciliation:before});
const controlPlane=applyKrg1ControlPlaneLocal({
  dbPath,
  intent,
  identityTab,
  relationTab,
  revision
});
const controlState=readKrg1DerivedControlState({dbPath});
if(
  !controlState ||
  String(controlState.processed_revision)!==revision ||
  String(controlState.status)!=="verified_live_derived_control"
){
  throw new Error("KRG1_DERIVED_CONTROL_STATE_READBACK_FAILED");
}
const after=await buildPlan();
const nonNoop=after.actions.filter(x=>x.kind!=="NOOP");
if(after.diagnostics.length||nonNoop.length){
  throw new Error("REGISTRY_IDEMPOTENCE_FAILED "+JSON.stringify({
    diagnostics:after.diagnostics,nonNoop
  }));
}

console.log(JSON.stringify({
  contract:"sosl_local_registry_apply_v0.1.0",
  ok:true,
  database_id:databaseId,
  krg1_revision:intent.krg1_revision,
  intent_entries:intent.entries.length,
  control_plane:controlPlane,
  control_state:{
    processed_revision:String(controlState.processed_revision),
    semantic_hash:String(controlState.semantic_hash),
    status:String(controlState.status),
    identity_count:Number(controlState.identity_count),
    relation_count:Number(controlState.relation_count)
  },
  before_action_counts:counts(before.actions),
  applied,
  after_action_counts:counts(after.actions),
  after_diagnostics:after.diagnostics.length,
  drive_write_attempted:false
},null,2));
