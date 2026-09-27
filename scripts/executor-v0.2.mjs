import { createSign, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { acquireLiveSourceModel, normalizeDesiredUnits } from "../src/live-source-model.mjs";
import { applySourceDeltaLocal } from "../src/local-v2-updater-core.mjs";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function googleAccessToken(scopes) {
  const raw=process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
  const credential=JSON.parse(raw);
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claims=b64url(JSON.stringify({
    iss:credential.client_email,
    scope:scopes.join(" "),
    aud:"https://oauth2.googleapis.com/token",
    iat:now,
    exp:now+3600
  }));
  const unsigned=header+"."+claims;
  const signer=createSign("RSA-SHA256");
  signer.update(unsigned); signer.end();
  const assertion=unsigned+"."+signer.sign(credential.private_key).toString("base64url");
  const response=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body=await response.json().catch(()=>({}));
  if (!response.ok || !body.access_token) throw new Error("Google token failed");
  return body.access_token;
}

async function driveMeta(fileId,token) {
  const url=
    "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const r=await fetch(url,{headers:{authorization:"Bearer "+token}});
  const body=await r.json().catch(()=>({}));
  if (!r.ok || body.id!==fileId || body.trashed===true || !body.version) {
    throw new Error("invalid Drive metadata for candidate");
  }
  return body;
}

function sqliteSourceState(dbPath,code) {
  const db=new DatabaseSync(dbPath);
  try {
    const row=db.prepare(`
      SELECT s.source_id,ss.last_processed_revision
      FROM v2_source_objects s
      JOIN v2_sync_state ss ON ss.source_id=s.source_id
      WHERE s.sosl_code=? AND s.active=1
    `).get(code);
    if (!row) throw new Error(code+": source missing in snapshot");
    const metadata=db.prepare(`
      SELECT content_text
      FROM v2_content_units
      WHERE source_id=? AND active=1 AND unit_type='source_metadata'
    `).get(row.source_id);
    if (!metadata) throw new Error(code+": source_metadata missing");
    return {
      last_processed_revision:row.last_processed_revision,
      metadata_text:metadata.content_text
    };
  } finally {
    db.close();
  }
}

function selectDatabase(plan,databaseId) {
  const db=plan.databases.find(x=>x.database_id===databaseId);
  if (!db) throw new Error("database not found in control: "+databaseId);
  return db;
}

const databaseId=String(process.env.SOSL_DATABASE_ID || "").trim();
const dbPath=String(process.env.SOSL_SQLITE_PATH || "").trim();
if (!databaseId || !dbPath) throw new Error("SOSL_DATABASE_ID and SOSL_SQLITE_PATH required");

const token=await googleAccessToken([
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly"
]);

const plan=await discoverExecutionPlan(token);
const database=selectDatabase(plan,databaseId);

const sourceSet=[
  ...(database.operational_sources ?? []),
  ...(database.frozen_sources ?? [])
];

const candidates=[];
for (const source of sourceSet) {
  const meta=await driveMeta(source.drive_file_id,token);
  const liveRevision="drive-version:"+String(meta.version);
  const state=sqliteSourceState(dbPath,source.code);
  if (liveRevision!==state.last_processed_revision) {
    candidates.push({
      code:source.code,
      drive_file_id:source.drive_file_id,
      mime_type:meta.mimeType,
      live_revision:liveRevision,
      baseline_revision:state.last_processed_revision,
      metadata_text:state.metadata_text
    });
  }
}

const results=[];
for (const candidate of candidates) {
  const acquired=await acquireLiveSourceModel({
    source:{
      sosl_code:candidate.code,
      drive_file_id:candidate.drive_file_id
    },
    accessToken:token
  });

  if (acquired.observed_revision!==candidate.live_revision) {
    throw new Error(candidate.code+": metadata/body revision mismatch");
  }

  const desired=normalizeDesiredUnits({
    source:{
      sosl_code:candidate.code,
      drive_file_id:candidate.drive_file_id
    },
    observedRevision:acquired.observed_revision,
    metadataText:candidate.metadata_text,
    units:acquired.units
  });

  const applied=applySourceDeltaLocal({
    dbPath,
    code:candidate.code,
    expectedBaselineRevision:candidate.baseline_revision,
    observedRevision:acquired.observed_revision,
    sourceHash:acquired.source_hash,
    desiredUnits:desired,
    title:acquired.title,
    mimeType:acquired.mime_type
  });

  results.push({
    code:candidate.code,
    mime_type:acquired.mime_type,
    ...applied
  });
}

const db=new DatabaseSync(dbPath);
const integrity=db.prepare("PRAGMA integrity_check").get().integrity_check;
const fk=db.prepare("PRAGMA foreign_key_check").all().length;
const counts={
  active_sources:Number(db.prepare("SELECT COUNT(*) AS n FROM v2_source_objects WHERE active=1").get().n),
  active_units:Number(db.prepare("SELECT COUNT(*) AS n FROM v2_content_units WHERE active=1").get().n),
  active_links:Number(db.prepare("SELECT COUNT(*) AS n FROM v2_condition_links WHERE active=1").get().n),
  active_identities:Number(db.prepare("SELECT COUNT(*) AS n FROM v2_identity_index WHERE active=1").get().n)
};
db.close();

if (integrity!=="ok" || fk!==0) {
  throw new Error("executor postvalidation failed");
}

console.log(JSON.stringify({
  contract:"sosl_sqlite_executor_v0.2.0",
  database_id:databaseId,
  observer_contract:process.env.SOSL_OBSERVER_CONTRACT || null,
  trigger_reason:process.env.SOSL_TRIGGER_REASON || null,
  candidate_count:candidates.length,
  results,
  integrity_check:integrity,
  foreign_key_violations:fk,
  counts,
  publication_attempted:false,
  drive_write_attempted:false
},null,2));
