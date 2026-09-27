import { DatabaseSync } from "node:sqlite";
import {
  googleAccessTokenFromServiceAccountJson,
  driveFileMeta
} from "../src/google-readonly.mjs";
import { RETIREMENT_HOLD_MS, RETIREMENT_PREFIX } from "../src/retirement-guard.js";

const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!dbPath) throw new Error("SOSL_SQLITE_PATH required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  ["https://www.googleapis.com/auth/drive.readonly"]
);

const db=new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_retirement_guard_state(
      sosl_code TEXT PRIMARY KEY,
      drive_file_id TEXT NOT NULL,
      registry_absent_seen_at_ms INTEGER NOT NULL,
      last_prefix_present INTEGER NOT NULL CHECK(last_prefix_present IN (0,1)),
      prefix_preexisting INTEGER NOT NULL CHECK(prefix_preexisting IN (0,1)),
      armed_at_ms INTEGER,
      due_at_ms INTEGER,
      last_observed_name TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  const registry=db.prepare(`
    SELECT sosl_code,drive_file_id,state,desired_presence,body_present
    FROM corpus_registry
    WHERE desired_presence='ABSENT' AND body_present=1
    ORDER BY sosl_code
  `).all().map(r=>({
    sosl_code:String(r.sosl_code),
    drive_file_id:String(r.drive_file_id),
    state:String(r.state),
    desired_presence:String(r.desired_presence),
    body_present:Number(r.body_present)
  }));

  const desiredCodes=new Set(registry.map(x=>x.sosl_code));
  for(const row of db.prepare("SELECT sosl_code FROM corpus_retirement_guard_state").all()){
    const code=String(row.sosl_code);
    if(!desiredCodes.has(code)){
      db.prepare("DELETE FROM corpus_retirement_guard_state WHERE sosl_code=?").run(code);
    }
  }

  const results=[];
  for(const reg of registry){
    if(reg.state==="RETIRING"){
      results.push({code:reg.sosl_code,mode:"ALREADY_RETIRING"});
      continue;
    }
    if(reg.state!=="INACTIVE"){
      results.push({code:reg.sosl_code,mode:"INVALID_REGISTRY_STATE",state:reg.state});
      continue;
    }

    const meta=await driveFileMeta(reg.drive_file_id,token);
    const currentName=String(meta.name||"");
    const prefixPresent=currentName.startsWith(RETIREMENT_PREFIX);
    const existing=db.prepare(`
      SELECT registry_absent_seen_at_ms,last_prefix_present,prefix_preexisting,armed_at_ms,due_at_ms
      FROM corpus_retirement_guard_state WHERE sosl_code=?
    `).get(reg.sosl_code)??null;
    const now=Date.now();

    if(!existing){
      db.prepare(`
        INSERT INTO corpus_retirement_guard_state(
          sosl_code,drive_file_id,registry_absent_seen_at_ms,last_prefix_present,
          prefix_preexisting,armed_at_ms,due_at_ms,last_observed_name,updated_at
        ) VALUES(?,?,?,?,?,NULL,NULL,?,datetime('now'))
      `).run(
        reg.sosl_code,reg.drive_file_id,now,prefixPresent?1:0,prefixPresent?1:0,currentName
      );
      results.push({
        code:reg.sosl_code,
        mode:prefixPresent?"PREFIX_PREEXISTING_BLOCKED":"AWAITING_PREFIX"
      });
      continue;
    }

    const lastPrefix=Number(existing.last_prefix_present)===1;
    let preexisting=Number(existing.prefix_preexisting)===1;
    let armedAt=existing.armed_at_ms==null?null:Number(existing.armed_at_ms);
    let dueAt=existing.due_at_ms==null?null:Number(existing.due_at_ms);

    if(preexisting && !prefixPresent){
      preexisting=false; armedAt=null; dueAt=null;
    } else if(!preexisting && !lastPrefix && prefixPresent){
      armedAt=now; dueAt=now+RETIREMENT_HOLD_MS;
    } else if(armedAt && !prefixPresent){
      armedAt=null; dueAt=null;
    }

    if(armedAt && dueAt && now>=dueAt && prefixPresent && !preexisting){
      const confirm=await driveFileMeta(reg.drive_file_id,token);
      if(String(confirm.name||"").startsWith(RETIREMENT_PREFIX)){
        const upd=db.prepare(`
          UPDATE corpus_registry
          SET state='RETIRING',updated_at=datetime('now')
          WHERE sosl_code=? AND desired_presence='ABSENT'
            AND state='INACTIVE' AND body_present=1
        `).run(reg.sosl_code);
        if(Number(upd.changes)!==1) throw new Error(reg.sosl_code+": RETIREMENT_PROMOTION_GUARD_FAILED");
        db.prepare("DELETE FROM corpus_retirement_guard_state WHERE sosl_code=?").run(reg.sosl_code);
        results.push({code:reg.sosl_code,mode:"PROMOTED_RETIRING",hold_ms:RETIREMENT_HOLD_MS});
        continue;
      }
      armedAt=null; dueAt=null;
    }

    db.prepare(`
      UPDATE corpus_retirement_guard_state
      SET drive_file_id=?,last_prefix_present=?,prefix_preexisting=?,armed_at_ms=?,
          due_at_ms=?,last_observed_name=?,updated_at=datetime('now')
      WHERE sosl_code=?
    `).run(
      reg.drive_file_id,prefixPresent?1:0,preexisting?1:0,
      armedAt,dueAt,currentName,reg.sosl_code
    );
    results.push({
      code:reg.sosl_code,
      mode:preexisting?"PREFIX_PREEXISTING_BLOCKED":armedAt?"HOLDING":"AWAITING_PREFIX",
      due_at_ms:dueAt
    });
  }

  console.log(JSON.stringify({
    contract:"sosl_local_retirement_reconcile_v0.1.0",
    ok:true,
    candidates:registry.length,
    hold_ms:RETIREMENT_HOLD_MS,
    results,
    drive_write_attempted:false
  },null,2));
} finally {
  db.close();
}
