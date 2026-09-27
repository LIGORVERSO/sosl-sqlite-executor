import { DatabaseSync } from "node:sqlite";
import {
  googleAccessTokenFromServiceAccountJson,
  driveFileMeta
} from "../src/google-readonly.mjs";
import {
  buildRetirementStatements,
  retirementResidueArgs,
  retirementReadbackSql,
  retirementDisposition
} from "../src/corpus-retirement.js";
import { RETIREMENT_PREFIX } from "../src/retirement-guard.js";

const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!dbPath) throw new Error("SOSL_SQLITE_PATH required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  ["https://www.googleapis.com/auth/drive.readonly"]
);

const db=new DatabaseSync(dbPath);
function scalar(sql,...args){
  const row=db.prepare(sql).get(...args);
  if(!row) return 0;
  return Number(Object.values(row)[0]??0);
}

try {
  db.exec("PRAGMA foreign_keys=ON");
  const candidates=db.prepare(`
    SELECT sosl_code,source_id,drive_file_id
    FROM corpus_registry
    WHERE desired_presence='ABSENT' AND state='RETIRING' AND body_present=1
    ORDER BY sosl_code
  `).all().map(r=>({
    sosl_code:String(r.sosl_code),
    source_id:String(r.source_id),
    drive_file_id:String(r.drive_file_id)
  }));

  const results=[];
  for(const reg of candidates){
    if(reg.sosl_code==="KRG1") throw new Error("KRG1_RETIREMENT_REQUIRES_CONTROL_PLANE_MIGRATION");
    const meta=await driveFileMeta(reg.drive_file_id,token);
    if(!String(meta.name||"").startsWith(RETIREMENT_PREFIX)){
      throw new Error(reg.sosl_code+": RETIREMENT_PREFIX_NO_LONGER_PRESENT");
    }

    const ftsRows=db.prepare(`
      SELECT content_pk,content_text,heading_path
      FROM v2_content_units WHERE source_id=? ORDER BY content_pk
    `).all(reg.source_id).map(r=>({
      content_pk:Number(r.content_pk),
      content_text:String(r.content_text),
      heading_path:r.heading_path==null?null:String(r.heading_path)
    }));

    const eventTable=scalar(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='v2_drive_change_events'"
    )===1;
    const statements=buildRetirementStatements({
      sourceId:reg.source_id,
      code:reg.sosl_code,
      eventTable,
      driveFileId:reg.drive_file_id,
      ftsRows
    });

    db.exec("BEGIN IMMEDIATE");
    try {
      for(const s of statements) db.prepare(s.sql).run(...s.args);

      const sql=retirementReadbackSql();
      const args=retirementResidueArgs({sourceId:reg.source_id,code:reg.sosl_code});
      const readback={
        body_count:scalar(sql.body_count,...args.body_count),
        owned_relations:scalar(sql.owned_relations,...args.owned_relations),
        incoming_relations:scalar(sql.incoming_relations,...args.incoming_relations),
        revisions:scalar(sql.revisions,...args.revisions),
        sync_state:scalar(sql.sync_state,...args.sync_state),
        source_object:scalar(sql.source_object,...args.source_object),
        orphan_fts:scalar(sql.orphan_fts)
      };
      const disposition=retirementDisposition(readback);
      if(disposition.mode.startsWith("FAIL_CLOSED")){
        throw new Error(reg.sosl_code+": "+disposition.mode+" "+JSON.stringify(readback));
      }

      const upd=db.prepare(`
        UPDATE corpus_registry
        SET body_present=0,updated_at=datetime('now')
        WHERE sosl_code=? AND desired_presence='ABSENT'
          AND state='RETIRING' AND body_present=1
      `).run(reg.sosl_code);
      if(Number(upd.changes)!==1) throw new Error(reg.sosl_code+": RETIREMENT_REGISTRY_ACK_FAILED");

      if(disposition.mode==="DELETE_REGISTRY_LAST"){
        const del=db.prepare(`
          DELETE FROM corpus_registry
          WHERE sosl_code=? AND desired_presence='ABSENT'
            AND state='RETIRING' AND body_present=0
        `).run(reg.sosl_code);
        if(Number(del.changes)!==1) throw new Error(reg.sosl_code+": RETIREMENT_TOMBSTONE_DELETE_FAILED");
      }

      db.exec("COMMIT");
      results.push({code:reg.sosl_code,readback,disposition});
    } catch(error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.exec("INSERT INTO v2_content_fts(v2_content_fts) VALUES('rebuild')");
  const integrity=db.prepare("PRAGMA integrity_check").get().integrity_check;
  const fk=db.prepare("PRAGMA foreign_key_check").all().length;
  const ftsOrphans=scalar(`
    SELECT COUNT(*) AS n FROM v2_content_fts f
    LEFT JOIN v2_content_units u ON u.content_pk=f.rowid
    WHERE u.content_pk IS NULL
  `);
  if(integrity!=="ok"||fk!==0||ftsOrphans!==0){
    throw new Error("RETIREMENT_POSTVALIDATION_FAILED "+JSON.stringify({integrity,fk,ftsOrphans}));
  }

  console.log(JSON.stringify({
    contract:"sosl_local_retirement_finalize_v0.1.0",
    ok:true,
    candidates:candidates.length,
    results,
    integrity_check:integrity,
    foreign_key_violations:fk,
    fts_orphans:ftsOrphans,
    drive_write_attempted:false
  },null,2));
} finally {
  db.close();
}
