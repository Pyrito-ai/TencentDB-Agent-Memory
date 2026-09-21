import { createHash } from "node:crypto";
import type { TaskEntity } from "../types.js";

export const BOARD_STATUSES = ["backlog", "ready", "in_progress", "review", "done"] as const;
export type BoardStatus = typeof BOARD_STATUSES[number];
export function taskBoardRevision(task: TaskEntity): string {
  return createHash("sha256").update(JSON.stringify([
    task.task_id, task.team_id, task.creator_user_id, task.title, task.description ?? "",
    task.status, task.metadata_json,
  ])).digest("hex");
}
export function taskBoardMetadata(task: TaskEntity): Record<string, unknown> {
  const value: unknown = JSON.parse(task.metadata_json || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task metadata must be a JSON object");
  return value as Record<string, unknown>;
}
export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
