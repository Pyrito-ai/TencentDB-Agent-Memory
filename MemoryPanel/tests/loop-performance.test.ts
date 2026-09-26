import { describe, expect, test } from "vitest";
import type {
  Loop,
  Occurrence,
} from "../web/src/pages/WorkbenchPage/components/loop-types";
import {
  formatLoopDay,
  getLoopPerformance,
} from "../web/src/pages/WorkbenchPage/utils/loop-performance";

const loop = (overrides: Partial<Loop> = {}): Loop => ({
  id: "weekly-review",
  name: "Weekly review",
  brief: "",
  project_id: "",
  area_id: "",
  owner_id: "",
  mode: "scheduled",
  start_date: "2026-01-01",
  frequency: "weekly",
  target: 1,
  timezone: "UTC",
  agents: [],
  archived: 0,
  canManage: true,
  today: "2026-09-26",
  nextDue: "",
  overdue: 0,
  slots: [],
  stats: {
    currentPeriod: "2026-09-21",
    progress: 0,
    target: 1,
    currentStreak: 0,
    bestStreak: 0,
    total: 0,
  },
  ...overrides,
});

const occurrence = (overrides: Partial<Occurrence> = {}): Occurrence => ({
  id: "review-1",
  loop_id: "weekly-review",
  author: "",
  task_id: null,
  agent_id: "",
  project_id: "",
  project_name: "",
  area_id: "",
  area_name: "",
  owner_id: "",
  due_day: "2026-09-23",
  brief: "",
  period: "2026-09-21",
  state: "completed",
  created_at: Date.parse("2026-09-21T12:00:00Z"),
  completed_at: Date.parse("2026-09-23T12:00:00Z"),
  note: "",
  result_url: "",
  time: [],
  ...overrides,
});

describe("loop performance", () => {
  test.each([
    [7, "2026-09-20", 7],
    [30, "2026-08-28", 30],
    [90, "2026-06-29", 13],
  ] as const)(
    "%i days includes today and keeps empty calendar buckets",
    (days, start, count) => {
      const result = getLoopPerformance([], [], days, "2026-09-26", "UTC");
      expect(result).toMatchObject({
        start,
        end: "2026-09-26",
        completed: 0,
        scheduledCompleted: 0,
        onTime: 0,
        overdue: 0,
        skipped: 0,
      });
      expect(result.buckets).toHaveLength(count);
      expect(result.buckets[0].start).toBe(start);
      expect(result.buckets.at(-1)?.end).toBe(result.end);
      expect(
        result.buckets.every((bucket) => !bucket.completed && !bucket.late),
      ).toBe(true);
    },
  );

  test("completion timestamps use the team's inclusive calendar window", () => {
    const timestamps = [
      "2026-09-20T06:59:59Z", // September 19 in Los Angeles.
      "2026-09-20T07:00:00Z", // First instant of the selected window.
      "2026-09-27T06:59:59Z", // Last second of the selected window.
      "2026-09-27T07:00:00Z", // September 27 in Los Angeles.
    ];
    const result = getLoopPerformance(
      [loop({ mode: "flexible" })],
      timestamps.map((timestamp, index) =>
        occurrence({
          id: String(index),
          completed_at: Date.parse(timestamp),
        }),
      ),
      7,
      "2026-09-26",
      "America/Los_Angeles",
    );
    expect(result.completed).toBe(2);
    expect(result.scheduledCompleted).toBe(0);
    expect(result.buckets.map((bucket) => bucket.completed)).toEqual([
      1, 0, 0, 0, 0, 0, 1,
    ]);
  });

  test("punctuality uses each loop's timezone and excludes flexible or undated completions", () => {
    const result = getLoopPerformance(
      [
        loop({ id: "new-york", timezone: "America/New_York" }),
        loop({ id: "madrid", timezone: "Europe/Madrid" }),
        loop({ id: "flexible", mode: "flexible" }),
      ],
      [
        occurrence({
          loop_id: "new-york",
          due_day: "2026-09-19",
          completed_at: Date.parse("2026-09-20T01:00:00Z"),
        }),
        occurrence({
          loop_id: "madrid",
          due_day: "2026-09-19",
          completed_at: Date.parse("2026-09-19T22:30:00Z"),
        }),
        occurrence({
          loop_id: "flexible",
          due_day: "2026-09-01",
          completed_at: Date.parse("2026-09-20T12:00:00Z"),
        }),
        occurrence({
          loop_id: "madrid",
          due_day: "",
          completed_at: Date.parse("2026-09-20T12:00:00Z"),
        }),
      ],
      7,
      "2026-09-20",
      "UTC",
    );
    expect(result).toMatchObject({
      completed: 4,
      scheduledCompleted: 2,
      onTime: 1,
    });
    expect(
      result.buckets.find((bucket) => bucket.start === "2026-09-19")?.late,
    ).toBe(1);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.late, 0)).toBe(
      1,
    );
  });

  test("late completion belongs to its completion window even when due and created earlier", () => {
    const result = getLoopPerformance(
      [loop()],
      [
        occurrence({
          due_day: "2026-08-01",
          period: "2026-07-27",
          created_at: Date.parse("2026-08-01T12:00:00Z"),
        }),
      ],
      7,
      "2026-09-26",
      "UTC",
    );
    expect(result).toMatchObject({
      completed: 1,
      scheduledCompleted: 1,
      onTime: 0,
    });
    expect(
      result.buckets.find((bucket) => bucket.start === "2026-09-23"),
    ).toMatchObject({ completed: 1, late: 1 });
  });

  test.each([
    [
      "2026-03-31",
      "2026-03-25",
      "2026-03-29",
      ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"],
    ],
    [
      "2026-10-27",
      "2026-10-21",
      "2026-10-25",
      ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"],
    ],
  ] as const)(
    "DST keeps seven calendar days through %s",
    (today, start, dueDay, timestamps) => {
      const result = getLoopPerformance(
        [loop({ timezone: "Europe/Madrid", today })],
        timestamps.map((timestamp, index) =>
          occurrence({
            id: String(index),
            due_day: dueDay,
            completed_at: Date.parse(timestamp),
          }),
        ),
        7,
        today,
        "Europe/Madrid",
      );
      expect(result.start).toBe(start);
      expect(result.buckets).toHaveLength(7);
      expect(result).toMatchObject({
        completed: 2,
        scheduledCompleted: 2,
        onTime: 2,
      });
      expect(
        result.buckets.find((bucket) => bucket.start === dueDay),
      ).toMatchObject({ completed: 2, late: 0 });
    },
  );

  test("overdue uses unresolved scheduled slots and the loop's today; skipped uses due days", () => {
    const unresolved = ["running", "submitted", "failed", "due", "overdue"];
    const result = getLoopPerformance(
      [
        loop({
          today: "2026-09-25",
          slots: [
            ...unresolved.map((state) => ({
              day: "2026-09-24",
              state,
              late: false,
            })),
            { day: "2026-09-19", state: "overdue", late: false },
            { day: "2026-09-25", state: "due", late: false },
            { day: "2026-09-26", state: "scheduled", late: false },
            { day: "2026-09-20", state: "completed", late: true },
            { day: "2026-09-21", state: "skipped", late: false },
            { day: "2026-09-27", state: "skipped", late: false },
          ],
        }),
        loop({
          id: "flexible",
          mode: "flexible",
          slots: [{ day: "2026-09-22", state: "overdue", late: false }],
        }),
      ],
      [occurrence({ state: "skipped", completed_at: null })],
      7,
      "2026-09-26",
      "UTC",
    );
    expect(result).toMatchObject({ completed: 0, overdue: 5, skipped: 1 });
  });

  test("archived loops retain their recorded history and incomplete occurrences are not completions", () => {
    const result = getLoopPerformance(
      [
        loop({
          archived: 1,
          slots: [
            { day: "2026-09-22", state: "skipped", late: false },
            { day: "2026-09-23", state: "overdue", late: false },
          ],
        }),
      ],
      [
        occurrence(),
        occurrence({ state: "running" }),
        occurrence({ state: "submitted" }),
        occurrence({ state: "failed" }),
        occurrence({ state: "skipped" }),
        occurrence({ completed_at: null }),
        occurrence({ completed_at: Number.NaN }),
      ],
      7,
      "2026-09-26",
      "UTC",
    );
    expect(result).toMatchObject({
      completed: 1,
      scheduledCompleted: 1,
      onTime: 1,
      skipped: 1,
      overdue: 0,
    });
  });

  test("90-day buckets are consecutive, include both boundaries, and preserve totals", () => {
    const result = getLoopPerformance(
      [loop()],
      ["2026-06-29", "2026-07-05", "2026-07-06", "2026-09-26"].map(
        (day, index) =>
          occurrence({
            id: String(index),
            due_day: index % 2 ? "2026-06-01" : day,
            completed_at: Date.parse(day + "T12:00:00Z"),
          }),
      ),
      90,
      "2026-09-26",
      "UTC",
    );
    expect(result.buckets[0]).toEqual({
      start: "2026-06-29",
      end: "2026-07-05",
      completed: 2,
      late: 1,
    });
    expect(result.buckets[1]).toEqual({
      start: "2026-07-06",
      end: "2026-07-12",
      completed: 1,
      late: 0,
    });
    expect(result.buckets.at(-1)).toEqual({
      start: "2026-09-21",
      end: "2026-09-26",
      completed: 1,
      late: 1,
    });
    for (let index = 1; index < result.buckets.length; index++) {
      expect(
        Date.parse(result.buckets[index].start) -
          Date.parse(result.buckets[index - 1].end),
      ).toBe(86_400_000);
    }
    expect(
      result.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    ).toBe(result.completed);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.late, 0)).toBe(
      result.scheduledCompleted - result.onTime,
    );
  });

  test("calendar labels use the supplied day regardless of the runtime timezone", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-09-20T12:00:00Z"));
    expect(formatLoopDay("2026-09-20")).toBe(expected);
  });
});
