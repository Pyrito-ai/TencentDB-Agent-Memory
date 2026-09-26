import { useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Badge, SummaryStrip, TaskRow } from '@/components/baren';
import type { Task } from '@/services';
import { readTaskBoard } from '@/services/task-board';
import {
  addDays,
  calendarWindow,
  localDay,
  taskSpan,
  validDay,
  weekSegments,
} from '@/services/task-schedule';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { getPanelSession } from '@/lib/panelSession';
import { useProjects } from '../hooks/useProjects';
import { todayFocus } from '../utils/today-focus';
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
  error,
  onRetry,
  currentUser,
  onOpenTask,
  onOpenLoops,
  onCreate,
  onOpenBoard,
}: {
  view: 'today' | 'upcoming';
  teamId: string;
  tasks: Task[];
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  currentUser: string;
  onOpenTask: (id: string) => void;
  onOpenLoops: (id?: string, due?: string) => void;
  onCreate?: () => void;
  onOpenBoard?: () => void;
}) {
  const areas = useAreas(teamId);
  const [loopOwner, setLoopOwner] = useState(currentUser),
    [loopArea, setLoopArea] = useState('all');
  const projects = useProjects(teamId),
    name = useDisplayNameResolver();
  const [person, setPerson] = useState('all'),
    [project, setProject] = useState('all'),
    [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const focus = todayFocus(filtered, today);
  const hasFilters = person !== 'all' || project !== 'all' || query.length > 0;
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
      <TaskRow
        className="agenda-task"
        key={task.task_id}
        onClick={() => onOpenTask(task.task_id)}
        copyClassName="agenda-task-copy"
        metaClassName="agenda-task-meta"
        title={task.title}
        subtitle={
          <>
            {projectName(task)}
            {b.priority !== 'none' && (
              <>
                {' '}
                <span aria-hidden="true">·</span>{' '}
                <Badge className={`project-board-priority ${b.priority}`}>{b.priority}</Badge>
              </>
            )}
          </>
        }
        meta={
          <>
            {b.dueDate && <small>{validDay(b.dueDate) ? dateLabel(b.dueDate) : b.dueDate}</small>}
            <span
              className="work-avatar"
              title={b.assignee ? name(b.assignee) : 'Unassigned'}
              aria-label={b.assignee ? `Assigned to ${name(b.assignee)}` : 'Unassigned'}
            >
              {b.assignee
                ? name(b.assignee)
                    .split(/\s+/)
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()
                : '—'}
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </>
        }
      />
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
      <header className="agenda-heading work-page-header">
        <div>
          <p className="work-eyebrow">
            {new Intl.DateTimeFormat('en', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(today + 'T12:00:00Z'))}
          </p>
          <h2>{view === 'today' ? 'Today' : 'Upcoming'}</h2>
          <p>
            {view === 'today'
              ? 'A little clarity. A good place to begin.'
              : 'Plan the next six weeks, from first step to deadline.'}
          </p>
        </div>
        <div className="work-actions">
          <button
            className="work-icon-button"
            title="Refresh"
            aria-label="Refresh tasks and responsibilities"
            onClick={() => {
              setToday(localDay());
              setVersion((v) => v + 1);
              window.dispatchEvent(new Event('tdai-memory.backend-refresh'));
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          {onCreate && (
            <button className="work-primary" onClick={onCreate}>
              <Plus size={16} aria-hidden="true" />
              New task
            </button>
          )}
        </div>
      </header>
      {view === 'today' && (
        <SummaryStrip
          className="agenda-summary"
          aria-label="Task summary"
          aria-busy={loading}
          valueFirst
          items={[
            {
              label: 'Overdue',
              value: loading || error ? '—' : focus.overdue.length,
              className: focus.overdue.length ? 'needs-attention' : '',
            },
            { label: 'In progress', value: loading || error ? '—' : focus.inProgress.length },
            { label: 'Needs review', value: loading || error ? '—' : focus.review.length },
          ]}
        />
      )}
      <div className="agenda-tools">
        <span>{hasFilters ? 'Showing filtered work' : 'Your team, at a glance'}</span>
        <button
          className="work-text-button"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          Filters{hasFilters ? ' · On' : ''}
        </button>
      </div>
      {filtersOpen && (
        <div className="agenda-filters work-filterbar">
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
          {hasFilters && (
            <button
              onClick={() => {
                setPerson('all');
                setProject('all');
                setQuery('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {projects.error && <p role="alert">Projects could not be loaded: {projects.error}</p>}
      {error ? (
        <div className="work-load-error" role="alert">
          <div>
            <strong>Tasks could not be loaded</strong>
            <p>{error}</p>
          </div>
          {onRetry && <button onClick={onRetry}>Retry tasks</button>}
        </div>
      ) : loading ? (
        <p role="status">Loading tasks…</p>
      ) : view === 'today' ? (
        <div className="agenda-today-grid">
          <div className="agenda-focus-column">
            <section className="agenda-section agenda-focus-panel">
              <header className="agenda-section-heading">
                <h3>
                  In progress <span>{focus.inProgress.length}</span>
                </h3>
                <span className="work-eyebrow">Keep moving</span>
              </header>
              {focus.inProgress.length ? (
                focus.inProgress.map(row)
              ) : (
                <p className="work-empty">
                  Nothing in progress. Pick your next task from the board.
                </p>
              )}
              <footer className="agenda-panel-footer">
                {onOpenBoard ? (
                  <button className="work-text-button" onClick={onOpenBoard}>
                    View task board <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ) : (
                  <a href="/#/">View task board →</a>
                )}
                {onCreate && (
                  <button className="work-text-button" onClick={onCreate}>
                    <Plus size={14} aria-hidden="true" />
                    Add task
                  </button>
                )}
              </footer>
            </section>
            {focus.overdue.length > 0 && (
              <section className="agenda-section overdue">
                <header className="agenda-section-heading">
                  <h3>
                    Overdue <span>{focus.overdue.length}</span>
                  </h3>
                  <span className="work-eyebrow">Needs attention</span>
                </header>
                {focus.overdue.map(row)}
              </section>
            )}
            {focus.review.length > 0 && (
              <section className="agenda-section">
                <header className="agenda-section-heading">
                  <h3>
                    Needs review <span>{focus.review.length}</span>
                  </h3>
                </header>
                {focus.review.map(row)}
              </section>
            )}
          </div>
          <aside className="agenda-aside">
            <section className="agenda-section agenda-schedule">
              <header className="agenda-section-heading">
                <h3>Schedule</h3>
                <CalendarDays size={17} aria-hidden="true" />
              </header>
              <p className="agenda-section-description">Today's dates, without the noise.</p>
              {focus.scheduled.length ? (
                focus.scheduled.map((task) => {
                  const board = readTaskBoard(task);
                  return (
                    <button
                      key={task.task_id}
                      className="agenda-schedule-item"
                      onClick={() => onOpenTask(task.task_id)}
                    >
                      <span className="agenda-schedule-marker" aria-hidden="true" />
                      <span>
                        <small>{board.dueDate === today ? 'DUE TODAY' : 'PLANNED TODAY'}</small>
                        <strong>{task.title}</strong>
                        <span>{projectName(task)}</span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="work-empty">A clear schedule. There are no task dates for today.</p>
              )}
              <p className="agenda-timezone">
                Task dates · {Intl.DateTimeFormat().resolvedOptions().timeZone}
              </p>
            </section>
            <section className="agenda-section agenda-responsibilities">
              <header className="agenda-section-heading">
                <h3>Responsibilities</h3>
                <span className="work-eyebrow">Loops</span>
              </header>
              <details className="agenda-loop-filters">
                <summary>Owner &amp; Area</summary>
                {loopControls()}
              </details>
              {loopError ? (
                <p role="alert">
                  {loopError} <button onClick={() => setVersion((v) => v + 1)}>Retry</button>
                </p>
              ) : !loops ? (
                <p role="status">Loading responsibilities…</p>
              ) : (
                <>
                  {pendingLoops
                    .filter(
                      (loop) =>
                        loop.mode === 'scheduled' &&
                        loop.slots.some((slot) => slot.state === 'due' || slot.state === 'overdue'),
                    )
                    .map((loop) => (
                      <button
                        className="agenda-loop"
                        key={loop.id}
                        onClick={() => onOpenLoops(loop.id, loop.nextDue)}
                      >
                        <strong>{loop.name}</strong>
                        <span>
                          {name(loop.owner_id)} · {loop.nextDue}
                        </span>
                        <small className={loop.overdue ? 'agenda-loop-late' : ''}>
                          {loop.overdue ? `${loop.overdue} overdue` : 'Due today'}
                        </small>
                      </button>
                    ))}
                  {pendingLoops
                    .filter((loop) => loop.mode === 'flexible')
                    .map((loop) => (
                      <button
                        className="agenda-loop"
                        key={loop.id}
                        onClick={() => onOpenLoops(loop.id)}
                      >
                        <strong>{loop.name}</strong>
                        <span>
                          {name(loop.owner_id)} · {loop.frequency}
                        </span>
                        <progress
                          value={Math.min(loop.stats.progress, loop.target)}
                          max={loop.target}
                          aria-label={`${loop.name} completion`}
                        />
                        <small>
                          {loop.stats.progress} of {loop.target} this period
                        </small>
                      </button>
                    ))}
                  {!pendingLoops.some(
                    (loop) =>
                      loop.mode === 'flexible' ||
                      loop.slots.some((slot) => slot.state === 'due' || slot.state === 'overdue'),
                  ) && (
                    <p className="work-empty">All caught up. No responsibilities need attention.</p>
                  )}
                </>
              )}
              <footer className="agenda-panel-footer">
                <button className="work-text-button" onClick={() => onOpenLoops()}>
                  View all Loops <ArrowRight size={14} aria-hidden="true" />
                </button>
              </footer>
            </section>
          </aside>
        </div>
      ) : (
        <section className="agenda-upcoming-surface work-surface">
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
        </section>
      )}
    </section>
  );
}
