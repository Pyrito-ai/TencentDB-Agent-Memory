import { expect, test } from "vitest";
import { todayFocus } from "../web/src/pages/WorkbenchPage/utils/today-focus";
import { writeTaskBoard, type TaskBoard } from "../web/src/services/task-board";

const task = (id: string, board: Partial<TaskBoard>, status = "running") => ({
  task_id: id,
  title: id,
  status,
  metadata_json: writeTaskBoard("{}", board),
});

test("workflow counts include overdue and scheduled work without counting completed tasks", () => {
  const result = todayFocus(
    [
      task("late", { status: "in_progress", dueDate: "2026-09-25" }),
      task("today", { status: "in_progress", dueDate: "2026-09-26" }),
      task("review", { status: "review", dueDate: "2026-09-25" }),
      task("done", { status: "review", dueDate: "2026-09-25" }, "completed"),
    ],
    "2026-09-26",
  );
  expect(result.overdue.map((t) => t.task_id)).toEqual(["late", "review"]);
  expect(result.inProgress.map((t) => t.task_id)).toEqual(["late", "today"]);
  expect(result.review.map((t) => t.task_id)).toEqual(["review"]);
  expect(result.scheduled.map((t) => t.task_id)).toEqual(["today"]);
});

test("schedule uses real date spans and ignores invalid, reversed, future and absent dates", () => {
  const result = todayFocus(
    [
      task("span", {
        status: "ready",
        plannedStart: "2026-09-20",
        dueDate: "2026-09-28",
      }),
      task("start", { status: "ready", plannedStart: "2026-09-26" }),
      task("invalid", { status: "ready", dueDate: "2026-02-30" }),
      task("reversed", {
        status: "ready",
        plannedStart: "2026-09-27",
        dueDate: "2026-09-26",
      }),
      task("future", { status: "ready", dueDate: "2026-09-27" }),
      task("undated", { status: "ready" }),
    ],
    "2026-09-26",
  );
  expect(result.scheduled.map((t) => t.task_id)).toEqual(["span", "start"]);
  expect(result.overdue).toEqual([]);
  expect(todayFocus([], "2026-09-26")).toEqual({
    overdue: [],
    inProgress: [],
    review: [],
    scheduled: [],
  });
});
