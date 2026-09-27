import { DatabaseSync } from "node:sqlite";

export const READER_CONTRACT = "unified_context_v1";

const REQUIRED = {
  corpus_registry:[
    "sosl_code","desired_presence","state","body_present"
  ],
  v2_identity_index:[
    "stable_ref","matter","external_name","grammar","state","authority","live_location","active"
  ],
  v2_source_objects:[
    "source_id","sosl_code","title","source_class","active"
  ],
  v2_content_units:[
    "content_pk","stable_ref","source_id","heading_path","content_text",
    "provenance_locator","position_ordinal","active"
  ],
  v2_condition_links:[
    "relation_id","subject_ref","predicate","object_ref","relation_class",
    "provenance_content_ref","provenance_locator","state","active"
  ]
};

function qident(name){
  return '"'+String(name).replaceAll('"','""')+'"';
}
function tableColumns(db,name){
  return new Set(
    db.prepare(`PRAGMA table_info(${qident(name)})`).all()
      .map(row=>String(row.name))
  );
}
function objectExists(db,name,types){
  const ps=types.map(()=>"?").join(",");
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE name=? AND type IN (${ps}) LIMIT 1`
  ).get(name,...types));
}

export function inspectReaderCapabilities(dbPath){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const missing=[];
    for(const [table,columns] of Object.entries(REQUIRED)){
      if(!objectExists(db,table,["table","view"])){
        missing.push({kind:"object",name:table});
        continue;
      }
      const actual=tableColumns(db,table);
      for(const column of columns){
        if(!actual.has(column)) missing.push({kind:"column",name:table+"."+column});
      }
    }
    if(!objectExists(db,"v2_content_fts",["table"])){
      missing.push({kind:"fts",name:"v2_content_fts"});
    } else {
      try{
        db.prepare(
          "SELECT rowid FROM v2_content_fts WHERE v2_content_fts MATCH ? LIMIT 1"
        ).all('"__reader_capability_probe__"');
      }catch(error){
        missing.push({
          kind:"fts_query",
          name:"v2_content_fts",
          detail:String(error?.message||error)
        });
      }
    }
    const sqliteIntegrity=String(db.prepare("PRAGMA integrity_check").get().integrity_check);
    return {
      contract:"sosl_reader_capability_probe_v1",
      reader_contract:READER_CONTRACT,
      compatible:missing.length===0 && sqliteIntegrity==="ok",
      missing,
      integrity_check:sqliteIntegrity,
      version_binding:false,
      snapshot_hash_binding:false,
      database_id_binding:false
    };
  }finally{
    db.close();
  }
}

export function assertReaderCompatible(dbPath){
  const report=inspectReaderCapabilities(dbPath);
  if(!report.compatible){
    throw new Error("READER_DATABASE_CAPABILITY_MISMATCH "+JSON.stringify(report));
  }
  return report;
}
