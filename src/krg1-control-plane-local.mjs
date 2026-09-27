import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const CONTROL_KEY="KRG1_CONTROL_PLANE";

function h(value){
  return createHash("sha256").update(String(value),"utf8").digest("hex");
}
function nullIfBlank(value){
  const s=String(value??"").trim();
  return s?s:null;
}
function rowCell(row,key){
  return row?.cells?.[key]??"";
}
function relationId({rid,subject,predicate,object}){
  return "relation-"+h(`KRG1|${rid}|${subject}|${predicate}|${object}`).slice(0,40);
}
function semanticHash({intent,identityRows,relationRows}){
  const canonical={
    membership:(intent?.entries??[]).map(x=>({
      sosl_code:String(x.sosl_code),
      drive_file_id:String(x.drive_file_id),
      registry_kind:String(x.registry_kind),
      desired_presence:String(x.desired_presence),
      state:String(x.state)
    })).sort((a,b)=>a.sosl_code.localeCompare(b.sosl_code)),
    identities:(identityRows??[]).map(({code,row})=>({
      code,
      macro_root:String(rowCell(row,"macrorraiz")??""),
      grammar:String(rowCell(row,"gramatica")??""),
      sequence:String(rowCell(row,"sequencia")??""),
      external_name:String(rowCell(row,"nome_externo")??""),
      matter:String(rowCell(row,"materia_principal")??""),
      function_text:String(rowCell(row,"funcao")??""),
      state:String(rowCell(row,"estado")??""),
      authority:String(rowCell(row,"autoridade")??""),
      live_location:String(rowCell(row,"localizacao_vigente")??"")
    })).sort((a,b)=>a.code.localeCompare(b.code)),
    relations:(relationRows??[]).map(({rid,row})=>({
      rid,
      subject:String(rowCell(row,"origem")??""),
      predicate:String(rowCell(row,"tipo_relacao")??""),
      object:String(rowCell(row,"destino")??""),
      state:String(rowCell(row,"estado_validacao")??"")
    })).sort((a,b)=>a.rid.localeCompare(b.rid))
  };
  return h(JSON.stringify(canonical));
}

export function normalizeKrg1ControlRows({identityTab,relationTab}){
  const identityRows=[];
  for(const row of identityTab?.rows??[]){
    const code=String(rowCell(row,"codigo_logico")??"").trim();
    if(!code||code==="codigo_logico") continue;
    identityRows.push({code,row});
  }
  const relationRows=[];
  for(const row of relationTab?.rows??[]){
    const rid=String(rowCell(row,"id_relacao")??"").trim();
    const subject=String(rowCell(row,"origem")??"").trim();
    const predicate=String(rowCell(row,"tipo_relacao")??"").trim();
    const object=String(rowCell(row,"destino")??"").trim();
    if(!rid||!subject||!predicate||!object) continue;
    relationRows.push({rid,row});
  }
  return {identityRows,relationRows};
}

export function applyKrg1ControlPlaneLocal({
  dbPath,intent,identityTab,relationTab,revision
}){
  const rev=String(revision??"").trim();
  if(!rev.startsWith("drive-version:")) throw new Error("KRG1_CONTROL_REVISION_INVALID");
  if((intent?.invalid_commands??[]).length){
    throw new Error("KRG1_CONTROL_INVALID_MEMBERSHIP_COMMANDS");
  }

  const {identityRows,relationRows}=normalizeKrg1ControlRows({identityTab,relationTab});
  if(!identityRows.length) throw new Error("KRG1_CONTROL_IDENTITIES_EMPTY");

  const corpusSet=new Set(
    (intent?.entries??[])
      .filter(x=>x.desired_presence==="PRESENT")
      .map(x=>String(x.sosl_code))
  );
  const desiredIdentityCodes=new Set(identityRows.map(x=>x.code));
  const desiredRelationIds=new Set();
  const ts=new Date().toISOString().replace(/\.\d{3}Z$/,"Z");
  const db=new DatabaseSync(dbPath);

  try{
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sosl_derived_control_state(
        control_key TEXT PRIMARY KEY,
        observed_revision TEXT NOT NULL,
        processed_revision TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        identity_count INTEGER NOT NULL,
        relation_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec("BEGIN IMMEDIATE");
    try{
      const identityUpsert=db.prepare(`
        INSERT INTO v2_identity_index(
          stable_ref,macro_root,grammar,sequence,external_name,matter,function_text,
          state,authority,provenance_source_id,provenance_locator,live_location,
          in_corpus,active
        ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,1)
        ON CONFLICT(stable_ref) DO UPDATE SET
          macro_root=excluded.macro_root,
          grammar=excluded.grammar,
          sequence=excluded.sequence,
          external_name=excluded.external_name,
          matter=excluded.matter,
          function_text=excluded.function_text,
          state=excluded.state,
          authority=excluded.authority,
          provenance_source_id=NULL,
          provenance_locator=excluded.provenance_locator,
          live_location=excluded.live_location,
          in_corpus=excluded.in_corpus,
          active=1
      `);
      for(const {code,row} of identityRows){
        identityUpsert.run(
          code,
          nullIfBlank(rowCell(row,"macrorraiz")),
          nullIfBlank(rowCell(row,"gramatica")),
          nullIfBlank(rowCell(row,"sequencia")),
          nullIfBlank(rowCell(row,"nome_externo"))??code,
          nullIfBlank(rowCell(row,"materia_principal")),
          nullIfBlank(rowCell(row,"funcao")),
          nullIfBlank(rowCell(row,"estado"))??"registered",
          nullIfBlank(rowCell(row,"autoridade")),
          `KRG1:IDENTIDADES:code:${code}`,
          nullIfBlank(rowCell(row,"localizacao_vigente")),
          corpusSet.has(code)?1:0
        );
      }

      const priorIdentityCodes=db.prepare(`
        SELECT stable_ref FROM v2_identity_index
        WHERE active=1 AND provenance_locator LIKE 'KRG1:IDENTIDADES:%'
      `).all().map(r=>String(r.stable_ref));
      const deactivateIdentity=db.prepare(`
        UPDATE v2_identity_index
        SET active=0,in_corpus=0,provenance_source_id=NULL
        WHERE stable_ref=? AND provenance_locator LIKE 'KRG1:IDENTIDADES:%'
      `);
      for(const code of priorIdentityCodes){
        if(!desiredIdentityCodes.has(code)) deactivateIdentity.run(code);
      }

      const relationUpsert=db.prepare(`
        INSERT INTO v2_condition_links(
          relation_id,subject_ref,predicate,object_ref,relation_class,
          provenance_source_id,provenance_content_ref,provenance_locator,state,
          subject_in_corpus,object_in_corpus,active,created_at,updated_at
        ) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,1,?,?)
        ON CONFLICT(relation_id) DO UPDATE SET
          subject_ref=excluded.subject_ref,
          predicate=excluded.predicate,
          object_ref=excluded.object_ref,
          relation_class=excluded.relation_class,
          provenance_source_id=NULL,
          provenance_content_ref=excluded.provenance_content_ref,
          provenance_locator=excluded.provenance_locator,
          state=excluded.state,
          subject_in_corpus=excluded.subject_in_corpus,
          object_in_corpus=excluded.object_in_corpus,
          active=1,
          updated_at=excluded.updated_at
      `);
      for(const {rid,row} of relationRows){
        const subject=String(rowCell(row,"origem")).trim();
        const predicate=String(rowCell(row,"tipo_relacao")).trim();
        const object=String(rowCell(row,"destino")).trim();
        const id=relationId({rid,subject,predicate,object});
        desiredRelationIds.add(id);
        relationUpsert.run(
          id,subject,predicate,object,"krg1_registered_relation",
          `KRG1:RELACOES:id:${rid}`,
          `KRG1:RELACOES:row:${row.row_number}`,
          nullIfBlank(rowCell(row,"estado_validacao"))??"registered",
          corpusSet.has(subject)?1:0,
          corpusSet.has(object)?1:0,
          ts,ts
        );
      }

      const priorRelations=db.prepare(`
        SELECT relation_id FROM v2_condition_links
        WHERE active=1 AND relation_class='krg1_registered_relation'
      `).all().map(r=>String(r.relation_id));
      const deactivateRelation=db.prepare(`
        UPDATE v2_condition_links
        SET active=0,provenance_source_id=NULL,updated_at=?
        WHERE relation_id=? AND relation_class='krg1_registered_relation'
      `);
      for(const id of priorRelations){
        if(!desiredRelationIds.has(id)) deactivateRelation.run(ts,id);
      }

      const hash=semanticHash({intent,identityRows,relationRows});
      db.prepare(`
        INSERT INTO sosl_derived_control_state(
          control_key,observed_revision,processed_revision,semantic_hash,status,
          identity_count,relation_count,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(control_key) DO UPDATE SET
          observed_revision=excluded.observed_revision,
          processed_revision=excluded.processed_revision,
          semantic_hash=excluded.semantic_hash,
          status=excluded.status,
          identity_count=excluded.identity_count,
          relation_count=excluded.relation_count,
          updated_at=excluded.updated_at
      `).run(
        CONTROL_KEY,rev,rev,hash,"verified_live_derived_control",
        identityRows.length,desiredRelationIds.size,ts
      );

      const activeIdentities=Number(db.prepare(`
        SELECT COUNT(*) AS n FROM v2_identity_index
        WHERE active=1 AND provenance_locator LIKE 'KRG1:IDENTIDADES:%'
      `).get().n);
      const activeRelations=Number(db.prepare(`
        SELECT COUNT(*) AS n FROM v2_condition_links
        WHERE active=1 AND relation_class='krg1_registered_relation'
      `).get().n);
      const sourceAnchor=Number(db.prepare(`
        SELECT COUNT(*) AS n FROM v2_source_objects
        WHERE sosl_code='KRG1' AND active=1
      `).get().n);
      const registryAnchor=Number(db.prepare(`
        SELECT COUNT(*) AS n FROM corpus_registry WHERE sosl_code='KRG1'
      `).get().n);
      if(activeIdentities!==identityRows.length){
        throw new Error(`KRG1_CONTROL_IDENTITY_READBACK ${activeIdentities}!=${identityRows.length}`);
      }
      if(activeRelations!==desiredRelationIds.size){
        throw new Error(`KRG1_CONTROL_RELATION_READBACK ${activeRelations}!=${desiredRelationIds.size}`);
      }
      if(sourceAnchor!==0||registryAnchor!==0){
        throw new Error("KRG1_CONTROL_BODY_ANCHOR_REINTRODUCED");
      }
      db.exec("COMMIT");

      return {
        ok:true,
        control_key:CONTROL_KEY,
        revision:rev,
        semantic_hash:hash,
        identities:activeIdentities,
        relations:activeRelations,
        in_corpus_identities:Number(db.prepare(`
          SELECT COUNT(*) AS n FROM v2_identity_index
          WHERE active=1
            AND provenance_locator LIKE 'KRG1:IDENTIDADES:%'
            AND in_corpus=1
        `).get().n),
        source_anchor:sourceAnchor,
        registry_anchor:registryAnchor
      };
    }catch(error){
      db.exec("ROLLBACK");
      throw error;
    }
  }finally{
    db.close();
  }
}

export function readKrg1DerivedControlState({dbPath}){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const exists=Number(db.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type='table' AND name='sosl_derived_control_state'
    `).get().n);
    if(!exists) return null;
    const row=db.prepare(`
      SELECT control_key,observed_revision,processed_revision,semantic_hash,status,
             identity_count,relation_count,updated_at
      FROM sosl_derived_control_state WHERE control_key=?
    `).get(CONTROL_KEY);
    return row??null;
  }finally{
    db.close();
  }
}
