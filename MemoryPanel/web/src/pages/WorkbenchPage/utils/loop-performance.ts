import type { Loop, Occurrence } from '../components/loop-types';

export type LoopPerformance = {
  start: string;
  end: string;
  completed: number;
  onTime: number;
  scheduledCompleted: number;
  overdue: number;
  skipped: number;
  buckets: { start: string; end: string; completed: number; late: number }[];
};

const dayMs = 24 * 60 * 60 * 1000;

function shiftDay(day: string, offset: number) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Calendar labels must not move a day when viewed west of UTC. */
export function formatLoopDay(day: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(day + 'T00:00:00Z'));
}

/**
 * Completion windows use team days; punctuality uses the loop's due-day timezone.
 * Archived loops retain recorded history, but only active loops create overdue work.
 */
export function getLoopPerformance(
  loops: Loop[],
  history: Occurrence[],
  days: 7 | 30 | 90,
  today: string,
  timezone: string,
): LoopPerformance {
  const start = shiftDay(today, 1 - days);
  const bucketSize = days === 90 ? 7 : 1;
  const buckets = Array.from({ length: Math.ceil(days / bucketSize) }, (_, index) => ({
    start: shiftDay(start, index * bucketSize),
    end: shiftDay(start, Math.min(days - 1, (index + 1) * bucketSize - 1)),
    completed: 0,
    late: 0,
  }));
  const result: LoopPerformance = {
    start,
    end: today,
    completed: 0,
    onTime: 0,
    scheduledCompleted: 0,
    overdue: 0,
    skipped: 0,
    buckets,
  };
  const byId = new Map(loops.map((loop) => [loop.id, loop]));
  const formatters = new Map<string, Intl.DateTimeFormat>();
  const localDay = (timestamp: number, zone: string) => {
    let formatter = formatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: zone,
      });
      formatters.set(zone, formatter);
    }
    const parts = formatter.formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  const inWindow = (day: string) => day >= start && day <= today;

  for (const occurrence of history) {
    if (
      occurrence.state !== 'completed' ||
      occurrence.completed_at === null ||
      !Number.isFinite(occurrence.completed_at)
    ) {
      continue;
    }
    const day = localDay(occurrence.completed_at, timezone);
    if (!inWindow(day)) continue;
    const dayIndex = (Date.parse(day + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / dayMs;
    const bucket = buckets[Math.floor(dayIndex / bucketSize)];
    result.completed++;
    bucket.completed++;

    const loop = byId.get(occurrence.loop_id);
    // Without a due day, historical completions cannot be judged on time or late.
    if (loop?.mode === 'scheduled' && occurrence.due_day) {
      result.scheduledCompleted++;
      if (localDay(occurrence.completed_at, loop.timezone || timezone) <= occurrence.due_day) {
        result.onTime++;
      } else {
        bucket.late++;
      }
    }
  }

  for (const loop of loops) {
    if (loop.mode !== 'scheduled') continue;
    for (const slot of loop.slots) {
      if (!inWindow(slot.day)) continue;
      if (slot.state === 'skipped') {
        result.skipped++;
      } else if (!loop.archived && slot.state !== 'completed' && slot.day < loop.today) {
        result.overdue++;
      }
    }
  }
  return result;
}
