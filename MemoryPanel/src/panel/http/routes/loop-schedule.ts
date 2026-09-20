import {
  localDay,
  periodFor,
  loopStats,
  type Frequency,
} from "./loop-periods.js";
export type ScheduleLoop = {
  mode: string;
  start_date: string;
  frequency: Frequency;
  timezone: string;
  target: number;
};
export type ScheduleRecord = {
  due_day: string;
  state: string;
  completed_at: number | null;
  period: string;
};
export function validDate(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    s >= "2000-01-01" &&
    s <= "2100-12-31" &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
  );
}
export function shiftDay(s: string, n: number) {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function scheduledDays(l: ScheduleLoop, through: string): string[] {
  if (l.mode !== "scheduled" || !validDate(l.start_date)) return [];
  const out: string[] = [];
  const anchor = new Date(l.start_date + "T12:00:00Z");
  for (let i = 0; i < 40000; i++) {
    let day: string;
    if (l.frequency === "monthly") {
      const first = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + i, 1, 12),
      );
      const last = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
      ).getUTCDate();
      first.setUTCDate(Math.min(anchor.getUTCDate(), last));
      day = first.toISOString().slice(0, 10);
    } else day = shiftDay(l.start_date, i * (l.frequency === "weekly" ? 7 : 1));
    if (day > through) break;
    out.push(day);
  }
  return out;
}
export function scheduleSummary(
  l: ScheduleLoop,
  history: ScheduleRecord[],
  now = Date.now(),
  through?: string,
) {
  const today = localDay(now, l.timezone),
    current = periodFor(now, l.timezone, l.frequency);
  const done = history.filter((o) => o.state === "completed");
  const base = loopStats(
    done.map((o) => o.period),
    current,
    l.frequency,
    l.target,
  );
  if (l.mode !== "scheduled")
    return { stats: base, today, slots: [], nextDue: "", overdue: 0 };
  const days = scheduledDays(
    l,
    through && through > shiftDay(today, 42) ? through : shiftDay(today, 42),
  );
  const records = new Map(
    history.filter((o) => o.due_day).map((o) => [o.due_day, o]),
  );
  const slots = days.map((day) => {
    const o = records.get(day);
    return {
      day,
      state:
        o?.state === "completed"
          ? "completed"
          : o?.state === "skipped"
            ? "skipped"
            : day < today
              ? "overdue"
              : day === today
                ? "due"
                : "scheduled",
      late:
        o?.state === "completed" &&
        o.completed_at !== null &&
        localDay(o.completed_at, l.timezone) > day,
    };
  });
  let best = 0,
    run = 0;
  const eligible = slots.filter(
    (s) =>
      s.day < today ||
      (s.day === today && ["completed", "skipped"].includes(s.state)),
  );
  for (const s of eligible) {
    run = s.state === "completed" && !s.late ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const next = slots.find(
    (s) => s.state !== "completed" && s.state !== "skipped",
  );
  return {
    stats: { ...base, currentStreak: run, bestStreak: best },
    today,
    slots,
    nextDue: next?.day || "",
    overdue: slots.filter((s) => s.state === "overdue").length,
  };
}
