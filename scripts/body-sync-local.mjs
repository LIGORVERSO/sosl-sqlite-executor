import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { googleAccessTokenFromServiceAccountJson, driveFileMeta } from "../src/google-readonly.mjs";
import { acquireLiveSourceModel, normalizeDesiredUnits } from "../src/live-source-model.mjs";
import { applySourceDeltaLocal, materializeSourceLocal } from "../src/local-v2-updater-core.mjs";

function identityFor(db,code){
  return db.prepare(`
    SELECT stable_ref,macro_root,grammar,external_name,matter,function_text,
           state,authority,live_location,in_corpus
    FROM v2_identity_index
    WHERE stable_ref=? AND active=1
  `).get(code)??null;
}
function metadataText(code,title,identity){
  if(!identity) return [code,title].filter(Boolean).join(" | ");
  return [
    code,title,identity.matter,identity.function_text,identity.state,
    identity.macro_root,identity.grammar
  ].map(x=>String(x??"").trim()).filter(Boolean).join(" | ");
}

const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!dbPath) throw new Error("SOSL_SQLITE_PATH required");
const reportPath=String(process.env.SOSL_BODY_SYNC_REPORT||"").trim();
const triggerReason=String(process.env.SOSL_TRIGGER_REASON||"").trim();
let observedDirty=null;
try{
  const raw=String(process.env.SOSL_DIRTY_FILES_JSON||"").trim();
  if(raw){
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed)) throw new Error("dirty files payload must be an array");
    observedDirty=new Map(parsed.map(x=>[
      String(x?.file_id||"").trim(),
      String(x?.observed_revision||"").trim()
    ]).filter(([id])=>id));
  }
}catch(error){
  throw new Error("SOSL_DIRTY_FILES_JSON_INVALID "+String(error?.message||error));
}

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);

const db=new DatabaseSync(dbPath,{readOnly:true});
let targets;
try{
  targets=db.prepare(`
    SELECT r.sosl_code,r.source_id,r.drive_file_id,r.adapter,r.registry_kind,
           r.desired_presence,r.state,r.body_present,
           s.title AS current_title,s.mime_type AS current_mime,
           ss.last_processed_revision
    FROM corpus_registry r
    LEFT JOIN v2_source_objects s ON s.source_id=r.source_id AND s.active=1
    LEFT JOIN v2_sync_state ss ON ss.source_id=r.source_id
    WHERE r.desired_presence='PRESENT'
      AND r.state='ACTIVE'
    ORDER BY r.sosl_code
  `).all().map(r=>({
    code:String(r.sosl_code),
    source_id:String(r.source_id),
    drive_file_id:String(r.drive_file_id),
    adapter:String(r.adapter),
    registry_kind:String(r.registry_kind),
    state:String(r.state),
    body_present:Number(r.body_present),
    current_title:r.current_title==null?null:String(r.current_title),
    current_mime:r.current_mime==null?null:String(r.current_mime),
    last_processed_revision:r.last_processed_revision==null?null:String(r.last_processed_revision)
  }));
}finally{db.close();}

const targetedSourceOnly=
  observedDirty instanceof Map &&
  observedDirty.size>0 &&
  !/REGISTRY_CHANGED/.test(triggerReason);
if(targetedSourceOnly){
  targets=targets.filter(target=>observedDirty.has(target.drive_file_id));
}

const results=[];
for(const target of targets){
  if(target.code==="KRG1") throw new Error("KRG1_BODY_MATERIALIZATION_FORBIDDEN");
  const meta=await driveFileMeta(target.drive_file_id,token);
  const liveRevision="drive-version:"+String(meta.version);
  if(targetedSourceOnly){
    const expected=observedDirty.get(target.drive_file_id);
    if(expected && expected!=="REMOVED" && expected!==liveRevision){
      throw new Error(
        target.code+": OBSERVED_REVISION_MOVED expected="+expected+
        " live="+liveRevision
      );
    }
  }
  if(target.body_present===1 && target.last_processed_revision===liveRevision){
    results.push({code:target.code,mode:"NOOP",revision:liveRevision});
    continue;
  }

  const dbMeta=new DatabaseSync(dbPath,{readOnly:true});
  let identity;
  try{ identity=identityFor(dbMeta,target.code); }
  finally{ dbMeta.close(); }

  const source={
    sosl_code:target.code,
    drive_file_id:target.drive_file_id,
    title:String(meta.name||target.current_title||identity?.external_name||target.code)
  };
  const acquired=await acquireLiveSourceModel({
    source,
    accessToken:token
  });
  if(acquired.observed_revision!==liveRevision){
    throw new Error(target.code+": DRIVE_METADATA_BODY_REVISION_MISMATCH");
  }
  const metaText=metadataText(target.code,acquired.title,identity);
  const desired=normalizeDesiredUnits({
    source,
    observedRevision:acquired.observed_revision,
    metadataText:metaText,
    units:acquired.units
  });

  if(target.body_present===0){
    const applied=materializeSourceLocal({
      dbPath,
      code:target.code,
      observedRevision:acquired.observed_revision,
      sourceHash:acquired.source_hash,
      desiredUnits:desired,
      title:acquired.title,
      mimeType:acquired.mime_type,
      sourceClass:identity?.grammar ??
        (target.registry_kind==="provisional_support"?"provisional_support":"registered_source"),
      authorityRole:identity?.authority ??
        (target.registry_kind==="provisional_support"
          ?"SUPORTE_PROVISORIO_NAO_IDENTITARIO"
          :"registered_authority"),
      liveLocation:identity?.live_location??null,
      sourceFormat:target.adapter
    });
    results.push({code:target.code,...applied});
    continue;
  }

  if(!target.last_processed_revision){
    throw new Error(target.code+": BODY_PRESENT_WITHOUT_SYNC_BASELINE");
  }
  const applied=applySourceDeltaLocal({
    dbPath,
    code:target.code,
    expectedBaselineRevision:target.last_processed_revision,
    observedRevision:acquired.observed_revision,
    sourceHash:acquired.source_hash,
    desiredUnits:desired,
    title:acquired.title,
    mimeType:acquired.mime_type
  });
  results.push({code:target.code,...applied});
}

const verify=new DatabaseSync(dbPath,{readOnly:true});
let remaining,integrity,fk,ftsOrphans;
try{
  remaining=Number(verify.prepare(`
    SELECT COUNT(*) AS n FROM corpus_registry
    WHERE desired_presence='PRESENT' AND state='ACTIVE' AND body_present=0
  `).get().n);
  integrity=String(verify.prepare("PRAGMA integrity_check").get().integrity_check);
  fk=verify.prepare("PRAGMA foreign_key_check").all().length;
  ftsOrphans=Number(verify.prepare(`
    SELECT COUNT(*) AS n FROM v2_content_fts f
    LEFT JOIN v2_content_units u ON u.content_pk=f.rowid
    WHERE u.content_pk IS NULL
  `).get().n);
}finally{verify.close();}
if(remaining!==0||integrity!=="ok"||fk!==0||ftsOrphans!==0){
  throw new Error("BODY_SYNC_POSTVALIDATION_FAILED "+JSON.stringify({
    remaining,integrity,fk,ftsOrphans
  }));
}

const report={
  contract:"sosl_local_body_sync_v0.1.0",
  ok:true,
  target_count:targets.length,
  selection_mode:targetedSourceOnly?"OBSERVER_DIRTY_SET":"FULL_PRESENT_SET",
  observed_dirty_count:observedDirty instanceof Map?observedDirty.size:0,
  materialized:results.filter(x=>x.mode==="MATERIALIZED").map(x=>x.code),
  updated:results.filter(x=>x.mode==="DELTA_APPLIED"||x.mode==="METADATA_ONLY").map(x=>x.code),
  noops:results.filter(x=>x.mode==="NOOP").length,
  results,
  remaining_present_without_body:remaining,
  integrity_check:integrity,
  foreign_key_violations:fk,
  fts_orphans:ftsOrphans,
  drive_write_attempted:false
};
if(reportPath) await writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
console.log(JSON.stringify(report,null,2));
