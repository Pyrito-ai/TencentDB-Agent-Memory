import { useEffect, useState } from 'react';
import type { Task } from '@/services';
import { readTaskBoard } from '@/services/task-board';
import {
  addDays,
  calendarWindow,
  localDay,
  taskSpan,
  todayBucket,
  weekSegments,
} from '@/services/task-schedule';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { getPanelSession } from '@/lib/panelSession';
import { useProjects } from '../hooks/useProjects';
import '../styles/agenda.css';

import type { Loop as LoopSummary } from './loop-types';
import { useAreas } from '../hooks/useAreas';
const dateLabel = (day: string) =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(day + 'T12:00:00Z'),
  );
export default function Agenda({
  view,
  teamId,
  tasks,
  loading,
  currentUser,
  onOpenTask,
  onOpenLoops,
}: {
  view: 'today' | 'upcoming';
  teamId: string;
  tasks: Task[];
  loading: boolean;
  currentUser: string;
  onOpenTask: (id: string) => void;
  onOpenLoops: (id?: string, due?: string) => void;
}) {
  const areas = useAreas(teamId);
  const [loopOwner, setLoopOwner] = useState(currentUser),
    [loopArea, setLoopArea] = useState('all');
  const projects = useProjects(teamId),
    name = useDisplayNameResolver();
  const [person, setPerson] = useState('all'),
    [project, setProject] = useState('all'),
    [query, setQuery] = useState('');
  const [today, setToday] = useState(localDay()),
    [offset, setOffset] = useState(0);
  const [loops, setLoops] = useState<LoopSummary[] | null>(null),
    [loopError, setLoopError] = useState(''),
    [loopZone, setLoopZone] = useState(''),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const tick = () => setToday(localDay());
    const timer = window.setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoops(null);
    setLoopError('');
    async function load() {
      try {
        const s = getPanelSession();
        if (!s) throw Error('Please sign in to view loops.');
        const r = await fetch(
          `/api/v1/loops/${encodeURIComponent(teamId)}/list?through=${calendarWindow(today, offset).end}`,
          {
            signal: controller.signal,
            headers: { 'X-Tdai-Service-Id': s.instanceId, 'X-Tdai-User-Key': s.userKey },
          },
        );
        const d = await r.json();
        if (!r.ok) throw Error(d.error || 'Unable to load loops.');
        if (active) {
          setLoops(d.items);
          setLoopZone(d.timezone);
        }
      } catch (e) {
        if (active) setLoopError(e instanceof Error ? e.message : 'Unable to load loops.');
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [teamId, view, today, version, offset]);
  const projectId = (task: Task) =>
    projects.assignments.find((a) => a.task === task.task_id)?.project_id || '';
  const projectName = (task: Task) =>
    projects.items.find((p) => p.id === projectId(task))?.name || 'Unassigned project';
  const people = [
    ...new Set([currentUser, ...tasks.map((t) => readTaskBoard(t).assignee).filter(Boolean)]),
  ];
  const filtered = tasks.filter((task) => {
    const b = readTaskBoard(task);
    return (
      (person === 'all' || b.assignee === person) &&
      (project === 'all' || projectId(task) === project) &&
      `${task.title} ${task.description}`.toLowerCase().includes(query.toLowerCase())
    );
  });
  const active = filtered.filter((t) => readTaskBoard(t).status !== 'done');
  const windowDays = calendarWindow(today, offset);
  const scheduled = active.filter((t) => {
    const s = taskSpan(t);
    return s && s.start <= windowDays.end && s.end >= windowDays.start;
  });
  const unscheduled = active.filter((t) => !taskSpan(t));
  const pendingLoops = (loops || []).filter(
    (l) =>
      !l.archived &&
      (l.mode === 'scheduled' || l.stats.progress < l.target) &&
      (project === 'all' || l.project_id === project) &&
      (loopOwner === 'all' || l.owner_id === loopOwner) &&
      (loopArea === 'all' || l.area_id === loopArea) &&
      l.name.toLowerCase().includes(query.toLowerCase()),
  );
  const row = (task: Task) => {
    const b = readTaskBoard(task);
    return (
      <button className="agenda-task" key={task.task_id} onClick={() => onOpenTask(task.task_id)}>
        <span>
          <strong>{task.title}</strong>
          <small>
            {projectName(task)} · {b.assignee ? name(b.assignee) : 'Unassigned'}
          </small>
        </span>
        <span className="agenda-task-meta">
          {b.priority !== 'none' && (
            <span className={`project-board-priority ${b.priority}`}>{b.priority}</span>
          )}
          <small>
            {b.status.replaceAll('_', ' ')}
            {b.dueDate && ` · Due ${b.dueDate}`}
          </small>
        </span>
      </button>
    );
  };
  function loopControls() {
    return (
      <>
        <div className="agenda-filters">
          <label>
            Loop owner
            <select value={loopOwner} onChange={(e) => setLoopOwner(e.target.value)}>
              <option value="all">Everyone</option>
              {[...new Set([currentUser, ...(loops || []).map((l) => l.owner_id)])].map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                  {id === currentUser ? ' (me)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Loop Area
            <select value={loopArea} onChange={(e) => setLoopArea(e.target.value)}>
              <option value="all">All Areas</option>
              {areas.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="agenda-help">
          Loop dates use {loopZone || 'the team timezone'}. Targets belong to their owner; others
          can contribute.
        </p>
        {areas.error && <p role="alert">{areas.error}</p>}
      </>
    );
  }
  return (
    <section className="agenda" aria-label={view === 'today' ? 'Today' : 'Upcoming'}>
      <header className="agenda-heading">
        <div>
          <p className="agenda-eyebrow">YOUR TEAM’S WORK</p>
          <h2>{view === 'today' ? 'Today' : 'Upcoming'}</h2>
          <p>
            {view === 'today'
              ? `${dateLabel(today)} · A clear view of what needs attention.`
              : 'Plan the next six weeks, from first step to deadline.'}
          </p>
        </div>
        <button
          onClick={() => {
            setToday(localDay());
            setVersion((v) => v + 1);
            window.dispatchEvent(new Event('tdai-memory.backend-refresh'));
          }}
        >
          Refresh
        </button>
      </header>
      <div className="agenda-filters">
        <label>
          Search
          <input
            placeholder="Find a task…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Assignee
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="all">Everyone</option>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p === currentUser ? `${name(p)} (me)` : name(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select
            value={project}
            disabled={!projects.loaded}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="all">All projects</option>
            <option value="">Unassigned</option>
            {projects.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="agenda-help">
        Task dates use your local calendar ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
        Completed tasks are hidden. Open any task for notes, attachments, time tracking, or
        scheduling.
      </p>
      {projects.error && <p role="alert">Projects could not be loaded: {projects.error}</p>}
      {loading ? (
        <p role="status">Loading tasks…</p>
      ) : view === 'today' ? (
        <>
          <div className="agenda-today-grid">
            <div>
              {(
                [
                  ['overdue', 'Overdue'],
                  ['due', 'Due today'],
                  ['planned', 'Planned for today'],
                  ['progress', 'In progress'],
                ] as const
              ).map(([bucket, label]) => {
                const items = filtered
                  .filter((t) => todayBucket(t, today) === bucket)
                  .sort(
                    (a, b) =>
                      readTaskBoard(a).dueDate.localeCompare(readTaskBoard(b).dueDate) ||
                      a.title.localeCompare(b.title),
                  );
                return (
                  <section className={`agenda-section ${bucket}`} key={bucket}>
                    <h3>
                      {label}
                      <span>{items.length}</span>
                    </h3>
                    {items.length ? (
                      items.map(row)
                    ) : (
                      <p className="agenda-empty">
                        {bucket === 'overdue' ? 'Nothing overdue.' : 'No tasks here.'}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
            <aside className="agenda-section">
              <h3>Loop responsibilities</h3>
              {loopControls()}
              {loopError ? (
                <p role="alert">
                  {loopError} <button onClick={() => setVersion((v) => v + 1)}>Retry</button>
                </p>
              ) : !loops ? (
                <p role="status">Loading Loops…</p>
              ) : (
                <>
                  <h4>Due & overdue</h4>
                  {pendingLoops
                    .filter(
                      (l) =>
                        l.mode === 'scheduled' &&
                        l.slots.some((s) => s.state === 'due' || s.state === 'overdue'),
                    )
                    .map((l) => (
                      <button
                        className="agenda-loop"
                        key={l.id}
                        onClick={() => onOpenLoops(l.id, l.nextDue)}
                      >
                        <strong>{l.name}</strong>
                        <span>
                          {name(l.owner_id)} · {l.nextDue}
                          {l.overdue ? ` · ${l.overdue} overdue` : ' · Due today'}
                        </span>
                      </button>
                    ))}
                  {!pendingLoops.some(
                    (l) =>
                      l.mode === 'scheduled' &&
                      l.slots.some((s) => s.state === 'due' || s.state === 'overdue'),
                  ) && <p>No deadlines due.</p>}
                  <h4>Flexible this period</h4>
                  {pendingLoops
                    .filter((l) => l.mode === 'flexible')
                    .map((l) => (
                      <button
                        className="agenda-loop"
                        key={l.id}
                        onClick={() => onOpenLoops(l.id, l.nextDue)}
                      >
                        <strong>{l.name}</strong>
                        <span>
                          {name(l.owner_id)} · {l.stats.progress} / {l.target} · {l.frequency}
                        </span>
                        <progress
                          value={Math.min(l.stats.progress, l.target)}
                          max={l.target}
                          aria-label={`${l.name} completion`}
                        />
                      </button>
                    ))}
                  {!pendingLoops.some((l) => l.mode === 'flexible') && (
                    <p>No unfinished flexible targets.</p>
                  )}
                </>
              )}
              <button onClick={() => onOpenLoops()}>Open Loops</button>
            </aside>
          </div>
        </>
      ) : (
        <>
          <div className="agenda-calendar-heading">
            <div>
              <h3>
                {dateLabel(windowDays.start)} – {dateLabel(windowDays.end)},{' '}
                {windowDays.end.slice(0, 4)}
              </h3>
              <p>{scheduled.length} scheduled tasks · Bars span planned start to due date.</p>
            </div>
            <div className="agenda-calendar-actions">
              <button aria-label="Previous six weeks" onClick={() => setOffset((n) => n - 6)}>
                ←
              </button>
              <button onClick={() => setOffset(0)}>This week</button>
              <button aria-label="Next six weeks" onClick={() => setOffset((n) => n + 6)}>
                →
              </button>
            </div>
          </div>
          {!scheduled.length && (
            <p className="agenda-empty">
              Nothing scheduled in this window. Open a task and set its planned start or due date.
            </p>
          )}
          <div className="agenda-calendar-scroll" tabIndex={0} aria-label="Six-week task calendar">
            <div className="agenda-calendar">
              <div className="agenda-weekdays">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, w) => {
                const start = addDays(windowDays.start, w * 7),
                  segments = weekSegments(scheduled, start);
                return (
                  <section
                    className="agenda-week"
                    key={start}
                    aria-label={`Week of ${dateLabel(start)}`}
                  >
                    <div className="agenda-dates">
                      {Array.from({ length: 7 }, (_, d) => {
                        const day = addDays(start, d);
                        return (
                          <time
                            dateTime={day}
                            key={day}
                            className={day === today ? 'is-today' : ''}
                          >
                            {dateLabel(day)}
                          </time>
                        );
                      })}
                    </div>
                    <div
                      className="agenda-bars"
                      style={{
                        minHeight: Math.max(
                          48,
                          (Math.max(-1, ...segments.map((s) => s.lane)) + 1) * 38,
                        ),
                      }}
                    >
                      {segments.map((s) => (
                        <button
                          key={s.task.task_id}
                          className={`agenda-bar ${readTaskBoard(s.task).priority}`}
                          style={{
                            gridColumn: `${s.start + 1} / ${s.end + 2}`,
                            gridRow: s.lane + 1,
                          }}
                          onClick={() => onOpenTask(s.task.task_id)}
                          title={`${s.task.title} · ${projectName(s.task)} · ${taskSpan(s.task)!.start} to ${taskSpan(s.task)!.end}`}
                          aria-label={`Open ${s.task.title}, ${taskSpan(s.task)!.start} to ${taskSpan(s.task)!.end}`}
                        >
                          {s.continuesBefore && '← '}
                          {s.task.title}
                          {s.continuesAfter && ' →'}
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
          <section className="agenda-section">
            <h3>Scheduled Loop deadlines</h3>
            {loopControls()}
            {loopError && <p role="alert">{loopError}</p>}
            {!loops && !loopError && <p>Loading Loops…</p>}
            {pendingLoops
              .flatMap((l) =>
                l.mode === 'scheduled'
                  ? l.slots
                      .filter(
                        (s) =>
                          s.day >= windowDays.start &&
                          s.day <= windowDays.end &&
                          s.state !== 'completed' &&
                          s.state !== 'skipped',
                      )
                      .map((s) => ({ l, s }))
                  : [],
              )
              .sort((a, b) => a.s.day.localeCompare(b.s.day))
              .map(({ l, s }) => (
                <button
                  className="agenda-task"
                  key={l.id + s.day}
                  onClick={() => onOpenLoops(l.id, s.day)}
                >
                  <strong>{l.name}</strong>
                  <span>
                    {s.day} · {name(l.owner_id)} · {s.state}
                  </span>
                </button>
              ))}
            <p className="agenda-help">
              Flexible Loops appear on Today while their period target is outstanding; they do not
              receive an invented deadline.
            </p>
          </section>
          <details className="agenda-section">
            <summary>Unscheduled / dates need attention ({unscheduled.length})</summary>
            <p className="agenda-help">
              Add a planned start or due date in task details. Invalid date ranges also appear here.
            </p>
            {unscheduled.map(row)}
          </details>
        </>
      )}
    </section>
  );
}
