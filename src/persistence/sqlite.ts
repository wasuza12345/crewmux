import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE events (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     id         TEXT NOT NULL UNIQUE,
     ts         INTEGER NOT NULL,
     run_id     TEXT NOT NULL,
     type       TEXT NOT NULL,
     body       TEXT NOT NULL
   );
   CREATE INDEX events_run ON events(run_id, seq);`,
];

/** .crewmux/state/harness.db — append-only event log (sessions, messages, deliveries, artifacts). */
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

/** Read-only handle for viewers (the panel) — never runs migrations, never writes. */
export function openDbReadonly(file: string): Db {
  return new Database(file, { readonly: true, fileMustExist: true });
}
