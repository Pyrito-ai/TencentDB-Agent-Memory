import { expect, test } from "vitest";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import {
  scheduledDays,
  scheduleSummary,
} from "../src/panel/http/routes/loop-schedule";
import {
  expandLoopSchema,
  backfillLoopAreas,
} from "../src/panel/http/routes/loop-migration";
const base = {
  mode: "scheduled",
  start_date: "2026-01-31",
  frequency: "monthly" as const,
  timezone: "Europe/Madrid",
  target: 1,
};
test("monthly deadlines clamp short months and return to the anchor day", () => {
  expect(scheduledDays(base, "2026-04-30")).toEqual([
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
    "2026-04-30",
  ]);
  expect(
    scheduledDays({ ...base, start_date: "2028-01-31" }, "2028-03-31"),
  ).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
});
test("late and skipped slots do not advance deadlines or inflate an on-time streak", () => {
  const l = { ...base, start_date: "2026-09-04", frequency: "weekly" as const };
  const history = [
    {
      due_day: "2026-09-04",
      period: "2026-08-31",
      state: "completed",
      completed_at: Date.parse("2026-09-07T12:00:00Z"),
    },
    {
      due_day: "2026-09-11",
      period: "2026-09-07",
      state: "skipped",
      completed_at: null,
    },
  ];
  const s = scheduleSummary(l, history, Date.parse("2026-09-18T12:00:00Z"));
  expect(s.nextDue).toBe("2026-09-18");
  expect(s.stats).toMatchObject({ currentStreak: 0, bestStreak: 0, total: 1 });
  expect(s.slots[0].late).toBe(true);
  expect(s.slots[1].state).toBe("skipped");
  expect(s.slots[2].state).toBe("due");
});
test("team timezone controls due-day transitions across DST", () => {
  const s = scheduleSummary(
    { ...base, start_date: "2026-03-30", frequency: "daily" },
    [],
    Date.parse("2026-03-29T22:30:00Z"),
  );
  expect(s.today).toBe("2026-03-30");
  expect(s.slots[0].state).toBe("due");
});
test("migration is idempotent and preserves legacy links and completion records across teams", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE loops(id TEXT PRIMARY KEY,instance TEXT,team TEXT,project_id TEXT,created_by TEXT);CREATE TABLE loop_occurrences(id TEXT PRIMARY KEY,loop_id TEXT,instance TEXT,team TEXT,completed_at INTEGER,period TEXT);INSERT INTO loops VALUES('one','default','A','project-a','alice'),('two','default','B','project-b','bob');INSERT INTO loop_occurrences VALUES('history','one','default','A',1234,'2026-08-31');`,
  );
  expandLoopSchema(db);
  backfillLoopAreas(db);
  const first = db.prepare("SELECT * FROM loops").all();
  expandLoopSchema(db);
  backfillLoopAreas(db);
  expect(db.prepare("SELECT * FROM loops").all()).toEqual(first);
  expect(db.prepare("SELECT COUNT(*) n FROM areas").get()!.n).toBe(2);
  expect(db.prepare("SELECT * FROM loops WHERE id='one'").get()).toMatchObject({
    owner_id: "alice",
    mode: "flexible",
    project_id: "project-a",
  });
  expect(db.prepare("SELECT * FROM loop_occurrences").get()).toMatchObject({
    completed_at: 1234,
    period: "2026-08-31",
    owner_id: "alice",
    area_name: "General responsibilities",
  });
  db.close();
});

test("calendar navigation can request deadlines beyond the initial six weeks", () => {
  const s = scheduleSummary(
    { ...base, start_date: "2026-09-04", frequency: "weekly" },
    [],
    Date.parse("2026-09-20T12:00:00Z"),
    "2026-12-06",
  );
  expect(s.slots.at(-1)?.day).toBe("2026-12-04");
  expect(s.nextDue).toBe("2026-09-04");
});
test("legacy backfill preserves a larger multi-team history", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE loops(id TEXT PRIMARY KEY,instance TEXT,team TEXT,project_id TEXT,created_by TEXT);CREATE TABLE loop_occurrences(id TEXT PRIMARY KEY,loop_id TEXT,instance TEXT,team TEXT,completed_at INTEGER,period TEXT);",
  );
  const insertLoop = db.prepare("INSERT INTO loops VALUES(?,?,?,?,?)"),
    insertHistory = db.prepare(
      "INSERT INTO loop_occurrences VALUES(?,?,?,?,?,?)",
    );
  db.exec("BEGIN");
  for (let n = 0; n < 500; n++) {
    const team = "team-" + (n % 20);
    insertLoop.run(
      "loop-" + n,
      "trial",
      team,
      "project-" + n,
      "owner-" + (n % 10),
    );
    for (let j = 0; j < 10; j++)
      insertHistory.run(
        n + "-" + j,
        "loop-" + n,
        "trial",
        team,
        100000 + n * 10 + j,
        "2026-08-31",
      );
  }
  db.exec("COMMIT");
  const before = db
    .prepare("SELECT SUM(completed_at) n FROM loop_occurrences")
    .get()!.n;
  expandLoopSchema(db);
  backfillLoopAreas(db);
  backfillLoopAreas(db);
  expect(db.prepare("SELECT COUNT(*) n FROM areas").get()!.n).toBe(20);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM loop_occurrences WHERE area_id!='' AND owner_id!=''",
      )
      .get()!.n,
  ).toBe(5000);
  expect(
    db.prepare("SELECT SUM(completed_at) n FROM loop_occurrences").get()!.n,
  ).toBe(before);
  db.close();
});
