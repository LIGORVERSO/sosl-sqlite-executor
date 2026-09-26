import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const contentId = (stableRef, revision, contentHash) => `content-${hash(`${stableRef}|${revision}|${contentHash}`).slice(0,40)}`;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const esc = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getSource(db, code) {
  const row = db.prepare(`SELECT s.source_id,s.sosl_code,s.title,s.mime_type,s.drive_file_id,
    ss.last_processed_revision,ss.last_verified_revision
    FROM v2_source_objects s JOIN v2_sync_state ss ON ss.source_id=s.source_id
    WHERE s.sosl_code=? AND s.active=1`).get(code);
  if (!row) throw new Error(`${code}: SOURCE_NOT_FOUND`);
  return row;
}

function identityMatcher(db) {
  const rows = db.prepare(`SELECT stable_ref,in_corpus FROM v2_identity_index WHERE active=1 ORDER BY length(stable_ref) DESC,stable_ref`).all();
  const byUpper = new Map(rows.map(r => [String(r.stable_ref).toUpperCase(), {code:String(r.stable_ref),in_corpus:Number(r.in_corpus)===1}]));
  const matcher = rows.length ? new RegExp(`(?<![A-Z0-9])(${rows.map(r=>esc(r.stable_ref)).join('|')})(?![A-Z0-9])`,'giu') : null;
  return {byUpper,matcher};
}

export function applySourceDeltaLocal({dbPath, code, expectedBaselineRevision, observedRevision, sourceHash, desiredUnits, title=null, mimeType=null}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const source = getSource(db, code);
    if (source.last_processed_revision !== expectedBaselineRevision) {
      throw new Error(`${code}: REVISION_GUARD_FAILED baseline=${expectedBaselineRevision} actual=${source.last_processed_revision}`);
    }
    const previousHashRow = db.prepare('SELECT source_hash FROM v2_source_revisions WHERE source_id=? AND observed_revision=?').get(source.source_id, source.last_processed_revision);
    const previousHash = previousHashRow?.source_hash ?? null;
    const ts = now();
    if (previousHash === sourceHash) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT OR REPLACE INTO v2_source_revisions(source_id,observed_revision,verified_revision,source_hash,observed_at,verified_at,verification_state) VALUES (?,?,?,?,?,?,?)`).run(source.source_id,observedRevision,observedRevision,sourceHash,ts,ts,'validated_same_body');
        const upd = db.prepare(`UPDATE v2_sync_state SET last_observed_revision=?,last_processed_revision=?,last_verified_revision=?,last_sync_status='verified_live',last_error=NULL,updated_at=? WHERE source_id=? AND last_processed_revision IS ?`).run(observedRevision,observedRevision,observedRevision,ts,source.source_id,expectedBaselineRevision);
        if (Number(upd.changes)!==1) throw new Error(`${code}: REVISION_GUARD_FAILED_METADATA_WRITE`);
        db.prepare('UPDATE v2_source_objects SET title=COALESCE(?,title),mime_type=COALESCE(?,mime_type),last_seen_at=? WHERE source_id=?').run(title,mimeType,ts,source.source_id);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return {ok:true,mode:'METADATA_ONLY',changed:0,added:0,removed:0,revision:observedRevision};
    }

    const desired = desiredUnits.map((u,i)=>({
      ...u,
      position_ordinal: u.position_ordinal ?? i,
      content_hash: u.content_hash ?? hash(u.content_text),
      content_id: u.content_id ?? contentId(u.stable_ref, observedRevision, u.content_hash ?? hash(u.content_text))
    }));
    const desiredByRef = new Map(desired.map(u=>[u.stable_ref,u]));
    const oldRows = db.prepare(`SELECT content_pk,content_id,stable_ref,unit_type,position_ordinal,heading_path,content_text,content_hash,active,provenance_locator FROM v2_content_units WHERE source_id=?`).all(source.source_id);
    const oldByRef = new Map(oldRows.map(r=>[r.stable_ref,r]));
    let maxPk = Number(db.prepare('SELECT COALESCE(MAX(content_pk),0) AS n FROM v2_content_units').get().n);
    let changed=0,added=0,removed=0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const unit of desired) {
        const old = oldByRef.get(unit.stable_ref);
        if (old && Number(old.active)===1 && old.content_hash===unit.content_hash) continue;
        if (old) {
          db.prepare(`UPDATE v2_content_units SET content_id=?,source_revision=?,unit_type=?,position_ordinal=?,heading_path=?,content_text=?,content_hash=?,semantic_state='derived_literal',verification_state='validated_live',active=1,supersedes_content_id=NULL,provenance_locator=?,updated_at=? WHERE content_pk=?`).run(unit.content_id,observedRevision,unit.unit_type,unit.position_ordinal,unit.heading_path??null,unit.content_text,unit.content_hash,unit.provenance_locator,ts,old.content_pk);
          changed++;
        } else {
          maxPk++;
          db.prepare(`INSERT INTO v2_content_units(content_pk,content_id,stable_ref,source_id,source_revision,plane,unit_type,position_ordinal,heading_path,content_text,content_hash,semantic_state,verification_state,active,supersedes_content_id,provenance_locator,created_at,updated_at) VALUES(?,?,?,?,?,'connected_lens_unspecified',?,?,?,?,?,'derived_literal','validated_live',1,NULL,?,?,?)`).run(maxPk,unit.content_id,unit.stable_ref,source.source_id,observedRevision,unit.unit_type,unit.position_ordinal,unit.heading_path??null,unit.content_text,unit.content_hash,unit.provenance_locator,ts,ts);
          added++;
        }
      }
      for (const old of oldRows) {
        if (Number(old.active)!==1 || desiredByRef.has(old.stable_ref)) continue;
        db.prepare('UPDATE v2_content_units SET active=0,updated_at=? WHERE content_pk=?').run(ts,old.content_pk);
        removed++;
      }
      db.prepare(`DELETE FROM v2_condition_links WHERE provenance_source_id=? AND relation_class='explicit_content_reference'`).run(source.source_id);
      const {byUpper,matcher}=identityMatcher(db);
      if (matcher) {
        const active=db.prepare('SELECT stable_ref,content_text,provenance_locator FROM v2_content_units WHERE source_id=? AND active=1').all(source.source_id);
        const ins=db.prepare(`INSERT OR IGNORE INTO v2_condition_links(relation_id,subject_ref,predicate,object_ref,relation_class,provenance_source_id,provenance_content_ref,provenance_locator,state,subject_in_corpus,object_in_corpus,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,1,?,?)`);
        for (const r of active) {
          matcher.lastIndex=0;
          for (const m of r.content_text.matchAll(matcher)) {
            const identity=byUpper.get(String(m[1]).toUpperCase());
            const ref=identity?.code ?? String(m[1]);
            if (ref===code) continue;
            const relationId=`relation-${hash(`${r.stable_ref}|REFERENCES_IDENTITY|${ref}|explicit_reference`).slice(0,40)}`;
            ins.run(relationId,r.stable_ref,'REFERENCES_IDENTITY',ref,'explicit_content_reference',source.source_id,r.stable_ref,r.provenance_locator,'validated_derived',identity?.in_corpus?1:0,ts,ts);
          }
        }
      }
      db.exec(`INSERT INTO v2_content_fts(v2_content_fts) VALUES('rebuild')`);
      const guard=getSource(db,code);
      if (guard.last_processed_revision!==expectedBaselineRevision) throw new Error(`${code}: REVISION_GUARD_FAILED_PREACK`);
      db.prepare(`INSERT OR REPLACE INTO v2_source_revisions(source_id,observed_revision,verified_revision,source_hash,observed_at,verified_at,verification_state) VALUES(?,?,?,?,?,?,?)`).run(source.source_id,observedRevision,observedRevision,sourceHash,ts,ts,'validated_live');
      const ack=db.prepare(`UPDATE v2_sync_state SET last_observed_revision=?,last_processed_revision=?,last_verified_revision=?,last_sync_status='verified_live',last_error=NULL,updated_at=? WHERE source_id=? AND last_processed_revision IS ?`).run(observedRevision,observedRevision,observedRevision,ts,source.source_id,expectedBaselineRevision);
      if (Number(ack.changes)!==1) throw new Error(`${code}: REVISION_GUARD_FAILED_ACK`);
      db.prepare('UPDATE v2_source_objects SET title=COALESCE(?,title),mime_type=COALESCE(?,mime_type),last_seen_at=? WHERE source_id=?').run(title,mimeType,ts,source.source_id);
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }

    const verified=getSource(db,code);
    if (verified.last_processed_revision!==observedRevision || verified.last_verified_revision!==observedRevision) throw new Error(`${code}: READBACK_REVISION_FAILED`);
    const activeCount=Number(db.prepare('SELECT COUNT(*) AS n FROM v2_content_units WHERE source_id=? AND active=1').get(source.source_id).n);
    if (activeCount!==desired.length) throw new Error(`${code}: READBACK_UNIT_COUNT_FAILED ${activeCount} != ${desired.length}`);
    const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
    const fk=db.prepare('PRAGMA foreign_key_check').all().length;
    const ftsOrphans=Number(db.prepare(`SELECT COUNT(*) AS n FROM v2_content_fts f LEFT JOIN v2_content_units u ON u.content_pk=f.rowid WHERE u.content_pk IS NULL`).get().n);
    if (integrity!=='ok'||fk!==0||ftsOrphans!==0) throw new Error(`${code}: POSTVALIDATION_FAILED integrity=${integrity} fk=${fk} fts_orphans=${ftsOrphans}`);
    return {ok:true,mode:'DELTA_APPLIED',changed,added,removed,active_units:activeCount,revision:observedRevision,integrity_check:integrity,foreign_key_violations:fk,fts_orphans:ftsOrphans};
  } finally { db.close(); }
}
