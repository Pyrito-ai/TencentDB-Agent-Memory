import { readTaskBoard } from '../../../services/task-board';
import { taskSpan, validDay, type Schedulable } from '../../../services/task-schedule';

/** Workflow counts are independent of date buckets: an overdue task may still be in progress. */
export function todayFocus<T extends Schedulable>(tasks: T[], today: string) {
  const active = tasks.filter((task) => readTaskBoard(task).status !== 'done');
  return {
    overdue: active.filter((task) => {
      const { dueDate } = readTaskBoard(task);
      return validDay(dueDate) && dueDate < today;
    }),
    inProgress: active.filter((task) => readTaskBoard(task).status === 'in_progress'),
    review: active.filter((task) => readTaskBoard(task).status === 'review'),
    scheduled: active.filter((task) => {
      const span = taskSpan(task);
      return span !== null && span.start <= today && span.end >= today;
    }),
  };
}
