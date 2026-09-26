import { DatabaseSync } from "node:sqlite";

function collectTextRuns(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.textRun && typeof node.textRun.content === "string") {
    const text = node.textRun.content.trim();
    if (text) out.push(text);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) collectTextRuns(item, out);
    } else if (value && typeof value === "object") {
      collectTextRuns(value, out);
    }
  }
}

function quoteFtsToken(token) {
  return '"' + String(token).replaceAll('"', '""') + '"';
}

export function proveDocumentToSqlite(document) {
  const chunks = [];
  collectTextRuns(document, chunks);
  if (!chunks.length) throw new Error("document contains no textual chunks");

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE source_chunks (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
        body,
        content='source_chunks',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    const insert = db.prepare("INSERT INTO source_chunks(body) VALUES (?)");
    const insertFts = db.prepare(
      "INSERT INTO source_chunks_fts(rowid, body) VALUES (?, ?)"
    );

    for (const body of chunks) {
      const row = insert.run(body);
      insertFts.run(Number(row.lastInsertRowid), body);
    }

    const lexical = chunks
      .join(" ")
      .match(/[\p{L}\p{N}]{4,}/u);

    if (!lexical) throw new Error("no lexical token suitable for FTS proof");

    const matches = db.prepare(`
      SELECT COUNT(*) AS n
      FROM source_chunks_fts
      WHERE source_chunks_fts MATCH ?
    `).get(quoteFtsToken(lexical[0]));

    const rows = db.prepare(
      "SELECT COUNT(*) AS n, SUM(length(body)) AS chars FROM source_chunks"
    ).get();
    const integrity = db.prepare("PRAGMA integrity_check").get();

    const result = {
      ok:
        integrity.integrity_check === "ok" &&
        Number(rows.n) === chunks.length &&
        Number(matches.n) > 0,
      contract: "sosl_docs_to_sqlite_local_probe_v0.1.0",
      sqlite: {
        integrity_check: integrity.integrity_check,
        chunk_rows: Number(rows.n),
        content_chars: Number(rows.chars ?? 0),
        fts_match_count: Number(matches.n)
      },
      safety: {
        sqlite_storage: "memory_only",
        source_content_logged: false,
        fts_query_logged: false,
        drive_write_attempted: false
      }
    };

    if (!result.ok) throw new Error("SQLite local proof invariants failed");
    return result;
  } finally {
    db.close();
  }
}
