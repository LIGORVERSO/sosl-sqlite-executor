#!/usr/bin/env python3
import argparse, json, sqlite3

ARCHIVED = ["PROV0008","PROV0013","PROV0017","PROV0018","PROV0020"]
CONTROL_SOURCE = "KRG1"
TEST_FIXTURE = "TESTV2I01"
CONTRACT = "sosl_local_snapshot_sanitizer_v0.1.0"

def scalar(c, sql, args=()):
    row = c.execute(sql, args).fetchone()
    return 0 if row is None else row[0]

def source(c, table, code):
    row = c.execute(f"SELECT source_id,sosl_code FROM {table} WHERE sosl_code=?", (code,)).fetchone()
    return None if row is None else {"source_id": row[0], "sosl_code": row[1]}

def registry(c, code):
    row = c.execute("SELECT sosl_code,source_id,desired_presence,state,body_present FROM corpus_registry WHERE sosl_code=?", (code,)).fetchone()
    if row is None:
        return None
    return dict(zip(["sosl_code","source_id","desired_presence","state","body_present"], row))

def incoming_v2(c, code, sid):
    return scalar(c, """SELECT COUNT(*) FROM v2_condition_links
      WHERE (provenance_source_id IS NULL OR provenance_source_id<>?)
        AND (subject_ref=? OR object_ref=? OR subject_ref LIKE ? OR object_ref LIKE ?)""",
      (sid, code, code, code+":%", code+":%"))

def counts(c):
    return {
      "v2_source_objects_active": scalar(c, "SELECT COUNT(*) FROM v2_source_objects WHERE active=1"),
      "v2_content_units_active": scalar(c, "SELECT COUNT(*) FROM v2_content_units WHERE active=1"),
      "v2_condition_links_active": scalar(c, "SELECT COUNT(*) FROM v2_condition_links WHERE active=1"),
      "v2_identity_index_active": scalar(c, "SELECT COUNT(*) FROM v2_identity_index WHERE active=1"),
      "test_fixture_units": scalar(c, """SELECT COUNT(*) FROM v2_content_units u
        JOIN v2_source_objects s ON s.source_id=u.source_id
        WHERE s.sosl_code=? AND u.active=1""", (TEST_FIXTURE,))
    }

def plan(c, mode):
    fixture = registry(c, TEST_FIXTURE)
    if not fixture or fixture["desired_presence"]!="PRESENT" or fixture["state"]!="INACTIVE" or int(fixture["body_present"])!=1:
        raise RuntimeError("TEST_FIXTURE_GUARD_FAILED")

    archived = []
    for code in ARCHIVED:
        reg = registry(c, code)
        src = source(c, "v2_source_objects", code)
        if not reg or not src:
            raise RuntimeError(f"{code}: REQUIRED_ARCHIVED_SOURCE_MISSING")
        if reg["desired_presence"]!="ABSENT" or reg["state"]!="INACTIVE" or int(reg["body_present"])!=1:
            raise RuntimeError(f"{code}: ARCHIVE_STATE_GUARD_FAILED")
        inc = incoming_v2(c, code, src["source_id"])
        if inc != 0:
            raise RuntimeError(f"{code}: EXTERNAL_RELATIONS_PRESENT={inc}")
        sid = src["source_id"]
        archived.append({
          "code": code,
          "active_content_rows": scalar(c, "SELECT COUNT(*) FROM v2_content_units WHERE source_id=? AND active=1", (sid,)),
          "owned_relations": scalar(c, "SELECT COUNT(*) FROM v2_condition_links WHERE provenance_source_id=?", (sid,)),
          "external_relations": inc
        })

    k2 = source(c, "v2_source_objects", CONTROL_SOURCE)
    k1 = source(c, "source_objects", CONTROL_SOURCE)
    kr = registry(c, CONTROL_SOURCE)
    if not k2 or not kr or kr["desired_presence"]!="ABSENT" or int(kr["body_present"])!=0:
        raise RuntimeError("KRG1_V2_CONTROL_SOURCE_GUARD_FAILED")

    return {
      "contract": CONTRACT,
      "mode": mode,
      "before": counts(c),
      "archived": archived,
      "krg1": {
        "v2_source_present": bool(k2),
        "v2_identity_rows_to_detach": scalar(c, "SELECT COUNT(*) FROM v2_identity_index WHERE provenance_source_id=?", (k2["source_id"],)),
        "v2_control_links_to_detach": scalar(c, "SELECT COUNT(*) FROM v2_condition_links WHERE provenance_source_id=?", (k2["source_id"],)),
        "legacy_source_present": bool(k1),
        "legacy_body_rows": 0 if not k1 else scalar(c, "SELECT COUNT(*) FROM content_units WHERE source_id=?", (k1["source_id"],))
      },
      "fixture": {"code": TEST_FIXTURE, "preserved": True, "active_units": counts(c)["test_fixture_units"]}
    }

def retire_archived(c, code):
    sid = source(c, "v2_source_objects", code)["source_id"]
    c.execute("DELETE FROM v2_condition_links WHERE provenance_source_id=?", (sid,))
    c.execute("DELETE FROM v2_content_units WHERE source_id=?", (sid,))
    c.execute("DELETE FROM v2_source_revisions WHERE source_id=?", (sid,))
    c.execute("DELETE FROM v2_sync_state WHERE source_id=?", (sid,))
    c.execute("DELETE FROM v2_source_objects WHERE source_id=?", (sid,))
    c.execute("""UPDATE corpus_registry SET body_present=0,state='INACTIVE',updated_at=datetime('now')
      WHERE sosl_code=? AND desired_presence='ABSENT'""", (code,))

def detach_v2_krg1(c):
    src = source(c, "v2_source_objects", CONTROL_SOURCE)
    if not src:
        return
    sid = src["source_id"]
    c.execute("UPDATE v2_identity_index SET provenance_source_id=NULL WHERE provenance_source_id=?", (sid,))
    c.execute("UPDATE v2_condition_links SET provenance_source_id=NULL WHERE provenance_source_id=?", (sid,))
    c.execute("DELETE FROM v2_source_revisions WHERE source_id=?", (sid,))
    c.execute("DELETE FROM v2_sync_state WHERE source_id=?", (sid,))
    c.execute("DELETE FROM v2_source_objects WHERE source_id=?", (sid,))
    c.execute("""UPDATE corpus_registry SET body_present=0,state='INACTIVE',updated_at=datetime('now')
      WHERE sosl_code='KRG1' AND desired_presence='ABSENT'""")

def detach_legacy_krg1(c):
    src = source(c, "source_objects", CONTROL_SOURCE)
    if not src:
        return
    sid = src["source_id"]
    ids = [r[0] for r in c.execute("SELECT content_id FROM content_units WHERE source_id=?", (sid,)).fetchall()]
    if ids:
        ph = ",".join("?" for _ in ids)
        c.execute(f"DELETE FROM graph_mentions WHERE content_id IN ({ph})", tuple(ids))
    c.execute("DELETE FROM content_units WHERE source_id=?", (sid,))
    c.execute("UPDATE identity_index SET provenance_source_id=NULL WHERE provenance_source_id=?", (sid,))
    c.execute("UPDATE condition_links SET provenance_source_id=NULL WHERE provenance_source_id=?", (sid,))
    c.execute("DELETE FROM source_revisions WHERE source_id=?", (sid,))
    c.execute("DELETE FROM sync_state WHERE source_id=?", (sid,))
    c.execute("DELETE FROM source_objects WHERE source_id=?", (sid,))

def validate(c):
    bad = scalar(c, """SELECT COUNT(*) FROM v2_source_objects
      WHERE sosl_code IN ('KRG1','PROV0008','PROV0013','PROV0017','PROV0018','PROV0020')""")
    archive_bodies = scalar(c, """SELECT COUNT(*) FROM corpus_registry
      WHERE sosl_code IN ('PROV0008','PROV0013','PROV0017','PROV0018','PROV0020') AND body_present<>0""")
    legacy_krg = scalar(c, "SELECT COUNT(*) FROM source_objects WHERE sosl_code='KRG1'")
    fixture = counts(c)["test_fixture_units"]
    fk = len(c.execute("PRAGMA foreign_key_check").fetchall())
    integrity = c.execute("PRAGMA integrity_check").fetchone()[0]
    v2_fts_orphans = scalar(c, """SELECT COUNT(*) FROM v2_content_fts f
      LEFT JOIN v2_content_units u ON u.content_pk=f.rowid WHERE u.content_pk IS NULL""")
    legacy_fts_orphans = scalar(c, """SELECT COUNT(*) FROM content_fts f
      LEFT JOIN content_units u ON u.content_pk=f.rowid WHERE u.content_pk IS NULL""")
    out = {
      **counts(c),
      "removed_sources_remaining": bad,
      "archive_bodies_remaining": archive_bodies,
      "legacy_krg_source_remaining": legacy_krg,
      "fixture_units": fixture,
      "foreign_key_violations": fk,
      "integrity_check": integrity,
      "v2_fts_orphans": v2_fts_orphans,
      "legacy_fts_orphans": legacy_fts_orphans
    }
    if bad or archive_bodies or legacy_krg or fixture<=0 or fk or integrity!="ok" or v2_fts_orphans or legacy_fts_orphans:
        raise RuntimeError("POSTVALIDATION_FAILED " + json.dumps(out))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan","apply"])
    ap.add_argument("--db", required=True)
    args = ap.parse_args()

    c = sqlite3.connect(args.db)
    c.execute("PRAGMA foreign_keys=ON")
    p = plan(c, args.mode)
    print("SANITIZE_PLAN " + json.dumps(p, separators=(",",":")))

    if args.mode == "plan":
        return

    c.execute("BEGIN IMMEDIATE")
    try:
        for code in ARCHIVED:
            retire_archived(c, code)
        detach_v2_krg1(c)
        detach_legacy_krg1(c)
        c.execute("INSERT INTO v2_content_fts(v2_content_fts) VALUES('rebuild')")
        c.execute("INSERT INTO content_fts(content_fts) VALUES('rebuild')")
        c.commit()
    except Exception:
        c.rollback()
        raise

    print("SANITIZE_APPLY_OK " + json.dumps({"contract": CONTRACT, "after": validate(c)}, separators=(",",":")))

if __name__ == "__main__":
    main()
