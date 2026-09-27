import { DatabaseSync } from "node:sqlite";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { compileCorpusRegistryIntent } from "../src/corpus-registry.js";
import { planCorpusReconciliation } from "../src/corpus-reconciler.js";
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
  if (!Array.isArray(values) || values.length<1) return [];
  const headers=(values[0]??[]).map(x=>String(x??"").trim());
  return values.slice(1).map((row,index)=>({
    row_number:index+2,
    cells:Object.fromEntries(headers.map((h,i)=>[h,row?.[i]??""]))
  }));
}

function selectDatabase(executionPlan,databaseId) {
  const item=executionPlan.databases.find(x=>x.database_id===databaseId);
  if (!item) throw new Error("database not found in control: "+databaseId);
  if (!item.registry_spreadsheet_id) throw new Error("registry_spreadsheet_id missing");
  return item;
}

function queryAll(db,sql,...args) {
  return db.prepare(sql).all(...args);
}

const databaseId=String(process.env.SOSL_DATABASE_ID||"").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if (!databaseId || !dbPath) throw new Error("SOSL_DATABASE_ID and SOSL_SQLITE_PATH required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);

const executionPlan=await discoverExecutionPlan(token);
const database=selectDatabase(executionPlan,databaseId);
const registryMeta=await driveFileMeta(database.registry_spreadsheet_id,token);

const [identityValues,provisionalValues]=await Promise.all([
  readSheetValues(database.registry_spreadsheet_id,"IDENTIDADES!A1:T999",token),
  readSheetValues(database.registry_spreadsheet_id,"SUPORTES_PROVISORIOS!A1:R999",token)
]);

const intent=compileCorpusRegistryIntent({
  sources:[{
    sosl_code:"KRG1",
    revision:"drive-version:"+String(registryMeta.version),
    tabs:[
      {title:"IDENTIDADES",rows:sheetRows(identityValues)},
      {title:"SUPORTES_PROVISORIOS",rows:sheetRows(provisionalValues)}
    ]
  }]
});

const db=new DatabaseSync(dbPath,{readOnly:true});
try {
  const currentRegistry=queryAll(db,`
    SELECT sosl_code,source_id,drive_file_id,adapter,registry_kind,desired_presence,state,body_present,
           membership_source_revision,membership_source_locator,updated_at
    FROM corpus_registry
    ORDER BY sosl_code
  `).map(r=>({
    sosl_code:String(r.sosl_code),
    source_id:String(r.source_id),
    drive_file_id:String(r.drive_file_id),
    adapter:String(r.adapter),
    registry_kind:String(r.registry_kind),
    desired_presence:String(r.desired_presence),
    state:String(r.state),
    body_present:Number(r.body_present),
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
        OR EXISTS(SELECT 1 FROM v2_content_units c WHERE c.source_id=s.source_id AND c.active=1)
      )
    ORDER BY s.sosl_code
  `).map(r=>({
    source_id:String(r.source_id),
    sosl_code:String(r.sosl_code),
    drive_file_id:String(r.drive_file_id),
    source_format:String(r.source_format)
  }));

  const registryCodes=new Set(currentRegistry.map(x=>x.sosl_code));
  const sourceCodes=new Set(currentSources.map(x=>x.sosl_code));
  const metadataByCode=new Map();
  for (const entry of intent.entries) {
    if (entry.desired_presence!=="PRESENT") continue;
    if (registryCodes.has(entry.sosl_code) || sourceCodes.has(entry.sosl_code)) continue;
    const meta=await driveFileMeta(entry.drive_file_id,token);
    metadataByCode.set(entry.sosl_code,{mime_type:String(meta.mimeType??"")});
  }

  const incomingRelationsByCode=new Map();
  for (const row of currentRegistry) {
    if (row.state!=="RETIRING") continue;
    const n=Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM v2_condition_links l
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

  const reconciliation=planCorpusReconciliation({
    intent,
    currentRegistry,
    currentSources,
    metadataByCode,
    adapterForMime,
    incomingRelationsByCode
  });

  const actionCounts=reconciliation.actions.reduce((acc,x)=>{
    acc[x.kind]=(acc[x.kind]??0)+1;
    return acc;
  },{});
  const diagnosticCounts=reconciliation.diagnostics.reduce((acc,x)=>{
    acc[x.kind]=(acc[x.kind]??0)+1;
    return acc;
  },{});

  console.log(JSON.stringify({
    contract:"sosl_local_registry_plan_v0.1.0",
    database_id:databaseId,
    krg1_revision:intent.krg1_revision,
    intent_entries:intent.entries.length,
    invalid_commands:intent.invalid_commands.length,
    current_registry_rows:currentRegistry.length,
    current_body_sources:currentSources.length,
    action_counts:actionCounts,
    diagnostic_counts:diagnosticCounts,
    actions:reconciliation.actions,
    diagnostics:reconciliation.diagnostics,
    sqlite_write_attempted:false,
    drive_write_attempted:false
  },null,2));
} finally {
  db.close();
}
