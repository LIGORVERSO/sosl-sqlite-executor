function prefixedRef(code){
  return String(code??"").trim()+":%";
}

export function retirementReadbackSql(){
  return {
    body_count:"SELECT COUNT(*) FROM v2_content_units WHERE source_id=?",
    owned_relations:"SELECT COUNT(*) FROM v2_condition_links WHERE provenance_source_id=?",
    incoming_relations:`SELECT COUNT(*) FROM v2_condition_links
      WHERE (provenance_source_id IS NULL OR provenance_source_id<>?)
        AND (subject_ref=? OR object_ref=? OR subject_ref LIKE ? OR object_ref LIKE ?)`,
    revisions:"SELECT COUNT(*) FROM v2_source_revisions WHERE source_id=?",
    sync_state:"SELECT COUNT(*) FROM v2_sync_state WHERE source_id=?",
    source_object:"SELECT COUNT(*) FROM v2_source_objects WHERE source_id=?",
    orphan_fts:"SELECT COUNT(*) FROM v2_content_fts f LEFT JOIN v2_content_units c ON c.content_pk=f.rowid WHERE c.content_pk IS NULL"
  };
}

export function buildRetirementStatements({sourceId,code,eventTable=false,driveFileId=null,ftsRows=[]}){
  const sid=String(sourceId??"").trim(), sosl=String(code??"").trim();
  if(!sid||!sosl)throw new Error("RETIREMENT_SOURCE_ID_OR_CODE_MISSING");
  const statements=[];
  for(const r of ftsRows){
    statements.push({
      stage:"FTS",
      sql:"INSERT INTO v2_content_fts(v2_content_fts,rowid,content_text,heading_path) VALUES('delete',?,?,?)",
      args:[Number(r.content_pk),String(r.content_text),r.heading_path==null?null:String(r.heading_path)]
    });
  }
  if(eventTable&&driveFileId){
    statements.push({
      stage:"EVENTS",
      sql:"DELETE FROM v2_drive_change_events WHERE source_code=? OR file_id=?",
      args:[sosl,String(driveFileId)]
    });
  }
  statements.push(
    {
      stage:"OWNED_RELATIONS",
      sql:"DELETE FROM v2_condition_links WHERE provenance_source_id=?",
      args:[sid]
    },
    {
      stage:"BODY",
      sql:"DELETE FROM v2_content_units WHERE source_id=?",
      args:[sid]
    },
    {
      stage:"REVISIONS",
      sql:"DELETE FROM v2_source_revisions WHERE source_id=?",
      args:[sid]
    },
    {
      stage:"SYNC_STATE",
      sql:"DELETE FROM v2_sync_state WHERE source_id=?",
      args:[sid]
    },
    {
      stage:"SOURCE_OBJECT",
      sql:"DELETE FROM v2_source_objects WHERE source_id=?",
      args:[sid]
    }
  );
  return statements;
}

export function retirementResidueArgs({sourceId,code}){
  const sid=String(sourceId), sosl=String(code);
  return {
    body_count:[sid],
    owned_relations:[sid],
    incoming_relations:[sid,sosl,sosl,prefixedRef(sosl),prefixedRef(sosl)],
    revisions:[sid],
    sync_state:[sid],
    source_object:[sid],
    orphan_fts:[]
  };
}

export function canDeleteRegistryTombstone(readback){
  const required=["body_count","owned_relations","incoming_relations","revisions","sync_state","source_object","orphan_fts"];
  return required.every(key=>Number(readback?.[key]??0)===0);
}

export function retirementDisposition(readback){
  if(Number(readback?.body_count??0)!==0)return {mode:"FAIL_CLOSED_BODY_RESIDUE"};
  if(Number(readback?.owned_relations??0)!==0)return {mode:"FAIL_CLOSED_OWNED_RELATION_RESIDUE"};
  if(Number(readback?.revisions??0)!==0||Number(readback?.sync_state??0)!==0||Number(readback?.source_object??0)!==0)return {mode:"FAIL_CLOSED_SOURCE_RESIDUE"};
  if(Number(readback?.orphan_fts??0)!==0)return {mode:"FAIL_CLOSED_FTS_RESIDUE"};
  if(Number(readback?.incoming_relations??0)!==0)return {mode:"KEEP_TOMBSTONE_EXTERNAL_RELATIONS",incoming_relations:Number(readback.incoming_relations)};
  return {mode:"DELETE_REGISTRY_LAST"};
}
