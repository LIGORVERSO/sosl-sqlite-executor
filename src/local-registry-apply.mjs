import { DatabaseSync } from "node:sqlite";

function foreignKeysAndIntegrity(db){
  const integrity=String(db.prepare("PRAGMA integrity_check").get()?.integrity_check||"");
  const fk=db.prepare("PRAGMA foreign_key_check").all().length;
  if(integrity!=="ok"||fk!==0){
    throw new Error("REGISTRY_POSTVALIDATION_FAILED "+JSON.stringify({integrity,fk}));
  }
  return {integrity_check:integrity,foreign_key_violations:fk};
}

export function applyCorpusRegistryPlanLocal({dbPath,reconciliation}) {
  const diagnostics=reconciliation?.diagnostics??[];
  if(diagnostics.length){
    throw new Error("REGISTRY_PLAN_DIAGNOSTICS_BLOCK_APPLY "+JSON.stringify(diagnostics));
  }

  const db=new DatabaseSync(dbPath);
  const counts={NOOP:0,UPSERT:0,DELETE:0};
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      for(const action of reconciliation?.actions??[]){
        if(action.kind==="NOOP"){
          counts.NOOP++;
          continue;
        }

        if(action.kind==="UPSERT"){
          const r=action.row;
          if(!r) throw new Error("REGISTRY_UPSERT_ROW_MISSING");
          db.prepare(`
            INSERT INTO corpus_registry(
              sosl_code,source_id,drive_file_id,adapter,registry_kind,
              desired_presence,state,body_present,
              membership_source_revision,membership_source_locator,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(sosl_code) DO UPDATE SET
              source_id=excluded.source_id,
              drive_file_id=excluded.drive_file_id,
              adapter=excluded.adapter,
              registry_kind=excluded.registry_kind,
              desired_presence=excluded.desired_presence,
              state=excluded.state,
              body_present=excluded.body_present,
              membership_source_revision=excluded.membership_source_revision,
              membership_source_locator=excluded.membership_source_locator,
              updated_at=datetime('now')
          `).run(
            r.sosl_code,r.source_id,r.drive_file_id,r.adapter,r.registry_kind,
            r.desired_presence,r.state,Number(r.body_present),
            r.membership_source_revision,r.membership_source_locator
          );
          counts.UPSERT++;
          continue;
        }

        if(action.kind==="DELETE"){
          const code=String(action.sosl_code||"");
          if(!code) throw new Error("REGISTRY_DELETE_CODE_MISSING");
          const row=db.prepare(
            "SELECT source_id FROM corpus_registry WHERE sosl_code=?"
          ).get(code);
          if(!row){
            counts.DELETE++;
            continue;
          }
          const sid=String(row.source_id);
          const sourceResidue=Number(db.prepare(
            "SELECT COUNT(*) AS n FROM v2_source_objects WHERE source_id=?"
          ).get(sid)?.n||0);
          const bodyResidue=Number(db.prepare(
            "SELECT COUNT(*) AS n FROM v2_content_units WHERE source_id=?"
          ).get(sid)?.n||0);
          const incoming=Number(db.prepare(`
            SELECT COUNT(*) AS n FROM v2_condition_links
            WHERE (provenance_source_id IS NULL OR provenance_source_id<>?)
              AND (
                subject_ref=? OR object_ref=? OR
                subject_ref LIKE ? OR object_ref LIKE ?
              )
          `).get(sid,code,code,code+":%",code+":%")?.n||0);
          if(sourceResidue||bodyResidue||incoming){
            throw new Error(code+": REGISTRY_DELETE_RESIDUE "+JSON.stringify({
              sourceResidue,bodyResidue,incoming
            }));
          }
          const del=db.prepare("DELETE FROM corpus_registry WHERE sosl_code=?").run(code);
          if(Number(del.changes)!==1) throw new Error(code+": REGISTRY_DELETE_GUARD_FAILED");
          counts.DELETE++;
          continue;
        }

        throw new Error("REGISTRY_ACTION_UNSUPPORTED "+String(action.kind));
      }
      db.exec("COMMIT");
    } catch(error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const validation=foreignKeysAndIntegrity(db);
    return {ok:true,counts,...validation};
  } finally {
    db.close();
  }
}
