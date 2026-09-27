#!/usr/bin/env python3
import argparse, hashlib, json, os, sqlite3, tempfile, zipfile
from datetime import datetime, timezone
from pathlib import Path

CONTRACT="sosl_snapshot_bundle_builder_v0.1.0"
INNER_NAME="GIL_SQLITE_SNAPSHOT_CURRENT.zip"
DB_NAME="GIL_SQLITE_SNAPSHOT_CURRENT.db"
META_NAME="GIL_SQLITE_SNAPSHOT_CURRENT.meta.json"

def sha256_file(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):
            h.update(chunk)
    return h.hexdigest()

def scalar(c,sql):
    return c.execute(sql).fetchone()[0]

def validate_db(path):
    c=sqlite3.connect(f"file:{Path(path).resolve()}?immutable=1",uri=True)
    try:
        integrity=c.execute("PRAGMA integrity_check").fetchone()[0]
        fk=len(c.execute("PRAGMA foreign_key_check").fetchall())
        if integrity!="ok" or fk:
            raise RuntimeError(f"SQLITE_VALIDATION_FAILED integrity={integrity} fk={fk}")
        counts={
            "source_objects":int(scalar(c,"SELECT COUNT(*) FROM v2_source_objects")),
            "active_sources":int(scalar(c,"SELECT COUNT(*) FROM v2_source_objects WHERE active=1")),
            "content_units":int(scalar(c,"SELECT COUNT(*) FROM v2_content_units WHERE active=1")),
            "condition_links":int(scalar(c,"SELECT COUNT(*) FROM v2_condition_links WHERE active=1")),
            "identity_index":int(scalar(c,"SELECT COUNT(*) FROM v2_identity_index WHERE active=1"))
        }
        v2_fts_orphans=int(scalar(c,"""
          SELECT COUNT(*) FROM v2_content_fts f
          LEFT JOIN v2_content_units u ON u.content_pk=f.rowid
          WHERE u.content_pk IS NULL
        """))
        legacy_fts_orphans=int(scalar(c,"""
          SELECT COUNT(*) FROM content_fts f
          LEFT JOIN content_units u ON u.content_pk=f.rowid
          WHERE u.content_pk IS NULL
        """))
        if v2_fts_orphans or legacy_fts_orphans:
            raise RuntimeError(
              f"FTS_ORPHANS v2={v2_fts_orphans} legacy={legacy_fts_orphans}"
            )
        return {
            "integrity_check":integrity,
            "foreign_key_violations":fk,
            "counts":counts,
            "v2_fts_orphans":v2_fts_orphans,
            "legacy_fts_orphans":legacy_fts_orphans
        }
    finally:
        c.close()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",required=True)
    ap.add_argument("--out",required=True)
    ap.add_argument("--executor-report")
    args=ap.parse_args()

    db=Path(args.db).resolve()
    out=Path(args.out).resolve()
    out.parent.mkdir(parents=True,exist_ok=True)
    validation=validate_db(db)

    report=None
    if args.executor_report:
        report=json.loads(Path(args.executor_report).read_text("utf8"))

    with tempfile.TemporaryDirectory(prefix="sosl-snapshot-") as tmp:
        tmp=Path(tmp)
        inner=tmp/INNER_NAME
        meta_path=tmp/META_NAME

        with zipfile.ZipFile(inner,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=True) as z:
            z.write(db,arcname=DB_NAME)

        generated=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
        meta={
            "contract":CONTRACT,
            "generated_at":generated,
            "builder":"LOCAL_INCREMENTAL",
            "sqlite_size_bytes":db.stat().st_size,
            "zip_size_bytes":inner.stat().st_size,
            "sqlite_sha256":sha256_file(db),
            "zip_sha256":sha256_file(inner),
            "integrity_check":validation["integrity_check"],
            "foreign_key_violations":validation["foreign_key_violations"],
            "counts":validation["counts"],
            "fts_orphans":{
                "v2":validation["v2_fts_orphans"],
                "legacy":validation["legacy_fts_orphans"]
            },
            "executor":{
                "contract":report.get("contract") if report else None,
                "candidate_count":report.get("candidate_count") if report else None,
                "candidates":report.get("candidates") if report else None
            }
        }
        meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+"\n","utf8")

        with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=True) as z:
            z.write(inner,arcname=INNER_NAME)
            z.write(meta_path,arcname=META_NAME)

        outer_hash=sha256_file(out)
        with zipfile.ZipFile(out,"r") as z:
            names=set(z.namelist())
            if names!={INNER_NAME,META_NAME}:
                raise RuntimeError("OUTER_BUNDLE_MEMBERS_INVALID "+repr(sorted(names)))
            embedded_meta=json.loads(z.read(META_NAME).decode("utf8"))
            inner_bytes=z.read(INNER_NAME)
        if hashlib.sha256(inner_bytes).hexdigest()!=embedded_meta["zip_sha256"]:
            raise RuntimeError("INNER_ZIP_HASH_MISMATCH")
        if len(inner_bytes)!=embedded_meta["zip_size_bytes"]:
            raise RuntimeError("INNER_ZIP_SIZE_MISMATCH")

        print(json.dumps({
            "contract":CONTRACT,
            "ok":True,
            "outer_path":str(out),
            "outer_size_bytes":out.stat().st_size,
            "outer_sha256":outer_hash,
            "meta":meta
        },ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
