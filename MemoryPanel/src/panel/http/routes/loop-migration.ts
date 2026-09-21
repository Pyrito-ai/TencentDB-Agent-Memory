import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
/** Additive schema migration. Original columns/history are retained for recovery. */
export function expandLoopSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS areas(id TEXT PRIMARY KEY,instance TEXT NOT NULL,team TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS area_name ON areas(instance,team,name COLLATE NOCASE);`);
  for (const [table, columns] of Object.entries({
    loops: {
      area_id: "TEXT NOT NULL DEFAULT ''",
      owner_id: "TEXT NOT NULL DEFAULT ''",
      mode: "TEXT NOT NULL DEFAULT 'flexible'",
      start_date: "TEXT NOT NULL DEFAULT ''",
    },
    loop_occurrences: {
      area_id: "TEXT NOT NULL DEFAULT ''",
      area_name: "TEXT NOT NULL DEFAULT ''",
      owner_id: "TEXT NOT NULL DEFAULT ''",
      due_day: "TEXT NOT NULL DEFAULT ''",
    },
  })) {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [name, definition] of Object.entries(columns))
      if (!existing.has(name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS loop_scheduled_slot ON loop_occurrences(instance,team,loop_id,due_day) WHERE due_day!=''",
  );
}
/** Separate idempotent data backfill; no projects, time entries or completion dates rewritten. */
export function backfillLoopAreas(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of db
      .prepare(
        "SELECT DISTINCT instance,team,created_by FROM loops WHERE area_id='' OR owner_id=''",
      )
      .all()) {
      let area = db
        .prepare(
          "SELECT id FROM areas WHERE instance=? AND team=? AND name='General responsibilities' COLLATE NOCASE",
        )
        .get(String(row.instance), String(row.team));
      if (!area) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO areas(id,instance,team,name,created_by,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          id,
          String(row.instance),
          String(row.team),
          "General responsibilities",
          String(row.created_by),
          Date.now(),
        );
        area = { id };
      }
      db.prepare(
        "UPDATE loops SET area_id=CASE WHEN area_id='' THEN ? ELSE area_id END,owner_id=CASE WHEN owner_id='' THEN created_by ELSE owner_id END WHERE instance=? AND team=?",
      ).run(String(area.id), String(row.instance), String(row.team));
    }
    db.exec(
      "UPDATE loop_occurrences SET area_id=(SELECT area_id FROM loops WHERE loops.id=loop_id),area_name=COALESCE((SELECT a.name FROM loops l JOIN areas a ON a.id=l.area_id WHERE l.id=loop_id),''),owner_id=(SELECT owner_id FROM loops WHERE loops.id=loop_id) WHERE area_id='' AND EXISTS(SELECT 1 FROM loops WHERE loops.id=loop_id)",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
