import { addDays } from '@/services/task-schedule';
import type { Loop, Occurrence } from './loop-types';
function dayInZone(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
function previousPeriod(p: string, frequency: string, delta: number) {
  const d = new Date(p + (frequency === 'monthly' ? '-01' : '') + 'T12:00:00Z');
  if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + delta);
  else d.setUTCDate(d.getUTCDate() + delta * (frequency === 'weekly' ? 7 : 1));
  return d.toISOString().slice(0, frequency === 'monthly' ? 7 : 10);
}
export default function LoopInsights({
  loop: l,
  history,
  compact = false,
  onDay,
}: {
  loop: Loop;
  history: Occurrence[];
  compact?: boolean;
  onDay?: (day: string) => void;
}) {
  const completed = history.filter((o) => o.state === 'completed' && o.completed_at !== null);
  const activity = new Map<string, number>();
  for (const o of completed) {
    const day = dayInZone(o.completed_at!, l.timezone);
    activity.set(day, (activity.get(day) || 0) + 1);
  }
  const days = Array.from({ length: compact ? 30 : 90 }, (_, i) =>
    addDays(l.today, i - (compact ? 29 : 89)),
  );
  const periods = Array.from({ length: 12 }, (_, i) =>
    previousPeriod(l.stats.currentPeriod, l.frequency, i - 11),
  );
  const counts = periods.map((period) => completed.filter((o) => o.period === period).length);
  const qualified = periods.map((period) =>
    l.mode === 'scheduled'
      ? completed.filter(
          (o) =>
            o.period === period && o.due_day && dayInZone(o.completed_at!, l.timezone) <= o.due_day,
        ).length
      : completed.filter((o) => o.period === period).length,
  );
  const totals = periods.map((period) => completed.filter((o) => o.period <= period).length);
  const bars = (values: number[], label: string) => (
    <div
      className="loop-mini-chart"
      role="img"
      aria-label={`${label}: ${periods.map((p, i) => `${p}: ${values[i]}`).join(', ')}`}
    >
      {values.map((n, i) => (
        <span
          key={periods[i]}
          title={`${periods[i]}: ${n}`}
          style={{
            height: `${Math.max(3, (n / Math.max(1, ...values)) * 100)}%`,
            opacity: n ? 1 : 0.2,
          }}
        />
      ))}
    </div>
  );
  if (compact)
    return (
      <div className="loop-activity-strip" aria-label="Last 30 days of activity">
        {days.map((day) => (
          <span
            key={day}
            className={activity.has(day) ? 'complete' : ''}
            title={`${day}: ${activity.get(day) || 0} completions`}
          />
        ))}
      </div>
    );
  const groups = new Map<string, string[]>();
  for (const day of days) {
    const month = day.slice(0, 7);
    groups.set(month, [...(groups.get(month) || []), day]);
  }
  return (
    <div className="loop-insights">
      <div className="loop-metrics">
        <article>
          <span>Current streak</span>
          <strong>{l.stats.currentStreak}</strong>
          <small>
            {l.mode === 'scheduled'
              ? 'consecutive on-time deadlines'
              : 'consecutive target periods'}
          </small>
          {bars(counts, 'Completions per period')}
          <small>
            Completions per{' '}
            {l.frequency === 'daily' ? 'day' : l.frequency === 'weekly' ? 'week' : 'month'}
          </small>
        </article>
        <article>
          <span>Best streak</span>
          <strong>{l.stats.bestStreak}</strong>
          <small>{l.mode === 'scheduled' ? 'on-time deadlines' : 'target periods'}</small>
          {bars(
            qualified.map((n) => Math.min(100, Math.round((n / l.target) * 100))),
            'Target met percentage',
          )}
          <small>Target attainment per period (%)</small>
        </article>
        <article>
          <span>Total completions</span>
          <strong>{l.stats.total}</strong>
          <small>all time · includes late work</small>
          {bars(totals, 'Cumulative completions')}
          <small>Cumulative completions</small>
        </article>
      </div>
      <section className="loop-calendar-panel">
        <h3>Last 90 days</h3>
        <p className="loop-help">
          {l.mode === 'scheduled'
            ? 'Calendar colors reflect deadlines. Select a due day to inspect its occurrence.'
            : 'Green marks activity, not a daily obligation. Streaks require the complete period target.'}{' '}
          · {l.timezone}
        </p>
        <div className="loop-calendar-legend">
          <span className="complete">Completed</span>
          <span className="late">Completed late</span>
          <span className="due">Due</span>
          <span className="overdue">Overdue</span>
          <span className="skipped">Skipped</span>
          <span>Not scheduled / no activity</span>
        </div>
        <div className="loop-calendar-months">
          {[...groups].map(([month, dates]) => (
            <section key={month}>
              <h4>
                {new Date(month + '-01T12:00:00Z').toLocaleDateString('en', {
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                })}
              </h4>
              <div className="loop-calendar-grid">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                  <small key={i}>{d}</small>
                ))}
                {dates.map((day, i) => {
                  const slot = l.slots.find((s) => s.day === day);
                  const status =
                    l.mode === 'scheduled'
                      ? slot?.late
                        ? 'late'
                        : slot?.state || 'neutral'
                      : activity.has(day)
                        ? 'complete'
                        : 'neutral';
                  const color = status === 'completed' ? 'complete' : status;
                  return (
                    <button
                      key={day}
                      className={color}
                      style={
                        i === 0
                          ? { gridColumn: ((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1 }
                          : undefined
                      }
                      disabled={!slot}
                      onClick={() => onDay?.(day)}
                      title={`${day}: ${status}; ${activity.get(day) || 0} completions recorded`}
                      aria-label={`${day}: ${status}`}
                    >
                      {Number(day.slice(-2))}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
