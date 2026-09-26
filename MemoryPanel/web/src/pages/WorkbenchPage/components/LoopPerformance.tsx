import { getLoopPerformance, formatLoopDay } from '../utils/loop-performance';
import type { LoopData } from './loop-types';
import '../styles/loop-performance.css';

export default function LoopPerformance({
  data,
  period,
  onPeriodChange,
}: {
  data: LoopData;
  period: 7 | 30 | 90;
  onPeriodChange: (period: 7 | 30 | 90) => void;
}) {
  const today =
    data.items[0]?.today ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: data.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const report = getLoopPerformance(data.items, data.history, period, today, data.timezone);
  const maximum = Math.max(1, ...report.buckets.map((bucket) => bucket.completed));
  const metrics = [
    { label: 'Completed', value: report.completed, detail: 'Occurrences finished in this period' },
    {
      label: 'Scheduled on time',
      value: report.scheduledCompleted
        ? `${Math.round((report.onTime / report.scheduledCompleted) * 100)}%`
        : '—',
      detail: `${report.onTime} of ${report.scheduledCompleted} scheduled completions`,
    },
    {
      label: 'Overdue deadlines',
      value: report.overdue,
      detail: 'Active loops · due in this period',
    },
    { label: 'Skipped deadlines', value: report.skipped, detail: 'Due in this period' },
  ];
  return (
    <section className="loop-performance work-surface" aria-labelledby="loop-performance-title">
      <header className="loop-performance-header">
        <div>
          <h3 id="loop-performance-title">Loop performance</h3>
          <p>
            {formatLoopDay(report.start)} – {formatLoopDay(report.end)} · {data.timezone}
          </p>
        </div>
        <label>
          Period
          <select
            value={period}
            onChange={(event) => onPeriodChange(Number(event.target.value) as 7 | 30 | 90)}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </header>
      <div className="loop-performance-metrics" aria-live="polite" aria-atomic="true">
        {metrics.map((metric) => (
          <article key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </div>
      <figure className="loop-performance-chart">
        <figcaption>
          <strong>Completions over time</strong>
          <span>{period === 90 ? 'Grouped by 7 days' : 'Daily activity'}</span>
        </figcaption>
        <div
          className="loop-chart-plot"
          role="img"
          aria-label={`${report.completed} completions over the last ${period} days. ${report.scheduledCompleted - report.onTime} scheduled completions were late. Exact counts follow in View activity data.`}
        >
          <div className="loop-chart-scale" aria-hidden="true">
            <span>{maximum}</span>
            <span>0</span>
          </div>
          <div className="loop-chart-bars" aria-hidden="true">
            {report.buckets.map((bucket) => (
              <div
                className="loop-chart-column"
                key={bucket.start}
                title={`${formatLoopDay(bucket.start)}${bucket.end !== bucket.start ? ` – ${formatLoopDay(bucket.end)}` : ''}: ${bucket.completed} completed, ${bucket.late} late`}
              >
                <div
                  className="loop-chart-bar"
                  style={{ height: `${(bucket.completed / maximum) * 100}%` }}
                >
                  {bucket.late > 0 && (
                    <span
                      className="is-late"
                      style={{ height: `${(bucket.late / bucket.completed) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          {!report.completed && <p className="loop-chart-empty">No completions in this period</p>}
        </div>
        <div className="loop-chart-axis" aria-hidden="true">
          <span>{formatLoopDay(report.start)}</span>
          <span>{formatLoopDay(report.end)}</span>
        </div>
        <div className="loop-chart-footnote">
          <span>
            <i />
            Completed
          </span>
          <span>
            <i className="is-late" />
            Completed late
          </span>
          <span>All loops, including archived · includes today</span>
        </div>
      </figure>
      <details className="loop-performance-data">
        <summary>View activity data</summary>
        <div className="loop-performance-table">
          <table>
            <caption>Completion dates in {data.timezone}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Completed</th>
                <th scope="col">Of these, late</th>
              </tr>
            </thead>
            <tbody>
              {report.buckets.map((bucket) => (
                <tr key={bucket.start}>
                  <th scope="row">
                    {formatLoopDay(bucket.start)}
                    {bucket.end !== bucket.start && ` – ${formatLoopDay(bucket.end)}`}
                  </th>
                  <td>{bucket.completed}</td>
                  <td>{bucket.late}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
