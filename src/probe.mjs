import process from "node:process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const started = process.hrtime.bigint();
const db = new DatabaseSync(":memory:");

function one(sql, ...params) {
  const stmt = db.prepare(sql);
  return params.length ? stmt.get(...params) : stmt.get();
}

let rollbackOk = false;

try {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE items_fts USING fts5(
      code,
      body,
      content='items',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  const ins = db.prepare("INSERT INTO items(code, body) VALUES (?, ?)");
  const a = ins.run("LPE001", "Caio voo mecanismo corpo");
  const b = ins.run("LRG07", "sono causalidade desenvolvimento");

  const ftsIns = db.prepare(
    "INSERT INTO items_fts(rowid, code, body) VALUES (?, ?, ?)"
  );
  ftsIns.run(Number(a.lastInsertRowid), "LPE001", "Caio voo mecanismo corpo");
  ftsIns.run(Number(b.lastInsertRowid), "LRG07", "sono causalidade desenvolvimento");

  const fts = db.prepare(`
    SELECT i.code, bm25(items_fts) AS score
    FROM items_fts
    JOIN items i ON i.id = items_fts.rowid
    WHERE items_fts MATCH ?
    ORDER BY score
    LIMIT 5
  `).all("voo");

  db.exec("BEGIN IMMEDIATE");
  try {
    ins.run("ROLLBACK_TEST", "primeiro");
    ins.run("ROLLBACK_TEST", "duplicado");
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
  }

  const rollbackResidue = one(
    "SELECT COUNT(*) AS n FROM items WHERE code='ROLLBACK_TEST'"
  );
  rollbackOk = Number(rollbackResidue.n) === 0;

  const integrity = one("PRAGMA integrity_check");
  const sqliteVersion = one("SELECT sqlite_version() AS v");
  const ftsCount = one("SELECT COUNT(*) AS n FROM items_fts");

  const elapsedMs =
    Number(process.hrtime.bigint() - started) / 1_000_000;

  const result = {
    ok:
      integrity.integrity_check === "ok" &&
      rollbackOk &&
      fts.length === 1 &&
      fts[0].code === "LPE001",
    contract: "sosl_sqlite_executor_probe_v0.1.0",
    node: process.version,
    sqlite: sqliteVersion.v,
    platform: process.platform,
    arch: process.arch,
    runner: {
      cpus: os.cpus().length,
      total_memory_mib: Math.round(os.totalmem() / 1024 / 1024)
    },
    checks: {
      integrity_check: integrity.integrity_check,
      fts5_bm25: fts,
      fts_rows: Number(ftsCount.n),
      rollback_atomicity_ok: rollbackOk
    },
    elapsed_ms: Number(elapsedMs.toFixed(3)),
    rss_mib: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2))
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
} finally {
  db.close();
}
