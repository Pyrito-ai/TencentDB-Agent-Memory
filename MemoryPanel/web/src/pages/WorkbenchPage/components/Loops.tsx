import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Play, Plus, RotateCw } from 'lucide-react';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { useProjects } from '../hooks/useProjects';
import { useAreas, workApi as api } from '../hooks/useAreas';
import Areas from './Areas';
import OccurrenceDetail from './OccurrenceDetail';
import LoopInsights from './LoopInsights';
import LoopPerformance from './LoopPerformance';
import type { Loop, LoopData } from './loop-types';
import '../styles/loops.css';
const empty = {
  name: '',
  brief: '',
  projectId: '',
  areaId: '',
  ownerId: '',
  mode: 'flexible' as 'flexible' | 'scheduled',
  startDate: '',
  frequency: 'weekly' as Loop['frequency'],
  target: 1,
  agents: [] as string[],
};
export default function Loops({
  teamId,
  currentUser,
  agents,
  onOpenTask,
  members = [],
  initialLoop = '',
  initialDue = '',
}: {
  teamId: string;
  currentUser: string;
  agents: { id: string; name: string }[];
  members?: { user_id: string; username?: string }[];
  initialLoop?: string;
  initialDue?: string;
  onOpenTask: (id: string) => void;
}) {
  const selectedOccurrenceRef = useRef<HTMLDivElement>(null);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const name = useDisplayNameResolver(),
    projects = useProjects(teamId),
    areas = useAreas(teamId);
  const [data, setData] = useState<LoopData | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0),
    [zone, setZone] = useState('UTC');
  const [form, setForm] = useState<typeof empty | null>(null),
    [editing, setEditing] = useState(''),
    [areaFilter, setAreaFilter] = useState('all'),
    [owner, setOwner] = useState('all'),
    [mode, setMode] = useState('all'),
    [showArchived, setShowArchived] = useState(false),
    [manageAreas, setManageAreas] = useState(false);
  const [detail, setDetail] = useState(initialLoop),
    [selected, setSelected] = useState(''),
    [dueDay, setDueDay] = useState(initialDue),
    [agent, setAgent] = useState(''),
    [skipReason, setSkipReason] = useState('');
  useEffect(() => {
    let active = true;
    void api(
      `loops/${encodeURIComponent(teamId)}/list${initialDue ? `?through=${encodeURIComponent(initialDue)}` : ''}`,
    )
      .then((d) => {
        if (active) {
          setData(d);
          setZone(d.timezone);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [teamId, version, initialDue]);
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  async function mutate(action: string, body: unknown) {
    setError('');
    setBusy(true);
    try {
      const d = await api(`loops/${encodeURIComponent(teamId)}/${action}`, body);
      setVersion((v) => v + 1);
      window.dispatchEvent(new Event('tdai-memory.backend-refresh'));
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
      return null;
    } finally {
      setBusy(false);
    }
  }
  const loop = data?.items.find((l) => l.id === detail),
    history = data?.history.filter((o) => o.loop_id === detail) || [],
    occurrence = history.find((o) => o.id === selected);
  const occurrenceId = occurrence?.id;
  useEffect(() => {
    if (occurrenceId) selectedOccurrenceRef.current?.focus();
  }, [occurrenceId]);
  function open(l: Loop) {
    setDetail(l.id);
    setSelected('');
    setDueDay(l.nextDue);
    setAgent('');
    setSkipReason('');
    setForm(null);
  }
  async function start(
    l: Loop,
    requestId: string = crypto.randomUUID(),
    slot = dueDay,
    agentId = agent,
  ) {
    const result = await mutate('start', { loopId: l.id, requestId, agentId, dueDay: slot });
    if (result?.occurrence) {
      const started = { ...result.occurrence, time: result.occurrence.time || [] };
      setData(
        (current) =>
          current && {
            ...current,
            history: [started, ...current.history.filter((item) => item.id !== started.id)],
          },
      );
      setSelected(started.id);
    } else setVersion((v) => v + 1);
  }
  function currentWork(l: Loop) {
    return data?.history.find(
      (item) =>
        item.loop_id === l.id &&
        (l.mode === 'scheduled'
          ? item.due_day === l.nextDue
          : item.author === currentUser && ['open', 'preparing'].includes(item.state)),
    );
  }
  function startFromCard(l: Loop) {
    const existing = currentWork(l);
    open(l);
    if (existing) setSelected(existing.id);
    else void start(l, crypto.randomUUID(), l.mode === 'scheduled' ? l.nextDue : '', '');
  }
  function edit(l?: Loop) {
    setEditing(l?.id || '');
    setForm(
      l
        ? {
            name: l.name,
            brief: l.brief,
            projectId: l.project_id,
            areaId: l.area_id,
            ownerId: l.owner_id,
            mode: l.mode,
            startDate: l.start_date,
            frequency: l.frequency,
            target: l.target,
            agents: l.agents,
          }
        : {
            ...empty,
            ownerId: currentUser,
            areaId: areas.items.find((a) => !a.archived)?.id || '',
          },
    );
  }
  const visible =
    data?.items.filter(
      (l) =>
        (showArchived || !l.archived) &&
        (owner === 'all' || l.owner_id === owner) &&
        (areaFilter === 'all' || l.area_id === areaFilter) &&
        (mode === 'all' || l.mode === mode),
    ) || [];
  const areaName = (id: string) => areas.items.find((a) => a.id === id)?.name || 'Area unavailable';
  const people = [
    ...new Set([
      currentUser,
      ...members.map((m) => m.user_id),
      ...(data?.items.map((l) => l.owner_id) || []),
    ]),
  ];
  const locked = !!editing && !!data?.history.some((o) => o.loop_id === editing);
  return (
    <section className="loops-view loop-dashboard">
      <header className="work-page-header">
        <div>
          {detail && (
            <button
              className="loop-back-link"
              onClick={() => {
                setDetail('');
                setForm(null);
              }}
            >
              <ArrowLeft size={15} aria-hidden="true" /> All Loops
            </button>
          )}
          <h2>{loop?.name || 'Loops'}</h2>
          {loop && (
            <p>
              {areaName(loop.area_id)} · Owner: {name(loop.owner_id)}
            </p>
          )}
        </div>
        <div className="work-actions">
          <button onClick={() => setManageAreas((v) => !v)}>Manage Areas</button>
          <button className="work-primary" disabled={busy} onClick={() => edit()}>
            <Plus size={16} aria-hidden="true" />
            New Loop
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setVersion((v) => v + 1);
              areas.reload();
            }}
          >
            <RotateCw size={15} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>
      {manageAreas && <Areas teamId={teamId} onChanged={areas.reload} />}
      {(error || areas.error || projects.error) && (
        <p role="alert" className="project-board-error">
          {error || areas.error || projects.error}
        </p>
      )}
      {!data && !error && (
        <p className="work-empty" role="status">
          Loading Loops…
        </p>
      )}
      {data && !data.items.length && data.canManageTimezone && (
        <form
          className="loop-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate('timezone', { timezone: zone });
          }}
        >
          <label>
            Team timezone
            <input value={zone} onChange={(e) => setZone(e.target.value)} required />
          </label>
          <button disabled={busy}>Save timezone</button>
        </form>
      )}
      {form && (
        <form
          className="loop-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await mutate(editing ? 'update' : 'create', { ...form, id: editing }))
              setForm(null);
          }}
        >
          <div className="loop-section-heading">
            <span className="work-eyebrow">Responsibility details</span>
            <h3>{editing ? 'Edit Loop' : 'New Loop'}</h3>
          </div>
          <label>
            Name
            <input
              required
              maxLength={160}
              value={form.name}
              disabled={busy}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <div className="loop-inline">
            <label>
              Area
              <select
                required
                value={form.areaId}
                disabled={busy}
                onChange={(e) => setForm({ ...form, areaId: e.target.value })}
              >
                <option value="">Choose an Area</option>
                {areas.items
                  .filter((a) => !a.archived)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Owner
              <select
                required
                value={form.ownerId}
                disabled={busy}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              >
                {people.map((id) => (
                  <option value={id} key={id}>
                    {members.find((m) => m.user_id === id)?.username || name(id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!areas.items.some((a) => !a.archived) && (
            <p>Create an Area with “Manage Areas” first.</p>
          )}
          <label>
            Project (optional)
            <select
              value={form.projectId}
              disabled={busy}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            >
              <option value="">No project</option>
              {projects.items
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <fieldset disabled={busy || locked}>
            <legend>Scheduling</legend>
            <label>
              Schedule type
              <select
                value={form.mode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    mode: e.target.value as typeof form.mode,
                    target: e.target.value === 'scheduled' ? 1 : form.target,
                  })
                }
              >
                <option value="flexible">Flexible — anytime within the period</option>
                <option value="scheduled">Scheduled — specific due date</option>
              </select>
            </label>
            <div className="loop-inline">
              <label>
                Frequency
                <select
                  value={form.frequency}
                  onChange={(e) =>
                    setForm({ ...form, frequency: e.target.value as Loop['frequency'] })
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {form.mode === 'flexible' ? (
                <label>
                  Target completions
                  <input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: Number(e.target.value) })}
                  />
                </label>
              ) : (
                <label>
                  First due date
                  <input
                    type="date"
                    required
                    min="2000-01-01"
                    max="2100-12-31"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </label>
              )}
            </div>
          </fieldset>
          <p className="loop-help">
            {form.mode === 'scheduled'
              ? 'One completion per deadline. Weekly repeats on the same weekday; monthly on the same day, or the last day of a shorter month. Late work does not move the schedule.'
              : 'Meet the target anytime within the day, Monday–Sunday week, or calendar month.'}{' '}
            Timezone: {data?.timezone || 'UTC'}. Scheduling is fixed after work starts.
          </p>
          <label>
            Reusable brief / acceptance criteria
            <textarea
              rows={4}
              maxLength={10000}
              value={form.brief}
              disabled={busy}
              onChange={(e) => setForm({ ...form, brief: e.target.value })}
            />
          </label>
          <fieldset disabled={busy}>
            <legend>Available agents (manual handoff)</legend>
            {agents.map((a) => (
              <label className="loop-check" key={a.id}>
                <input
                  type="checkbox"
                  checked={form.agents.includes(a.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      agents: e.target.checked
                        ? [...form.agents, a.id]
                        : form.agents.filter((id) => id !== a.id),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
          <div className="loop-inline">
            <button className="work-primary" disabled={busy || !form.areaId}>
              Save Loop
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {data && !loop && (
        <>
          <LoopPerformance data={data} period={period} onPeriodChange={setPeriod} />
          <section className="loop-active-section" aria-labelledby="loop-active-title">
            <div className="loop-active-heading">
              <h3 id="loop-active-title">{showArchived ? 'All loops' : 'Active loops'}</h3>
              <span>
                {visible.length} {visible.length === 1 ? 'loop' : 'loops'}
              </span>
            </div>
            <div className="loop-filter-panel work-filterbar" aria-label="Filter Loops">
              <label>
                Owner
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="all">All owners</option>
                  {people.map((id) => (
                    <option key={id} value={id}>
                      {name(id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Area
                <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
                  <option value="all">All Areas</option>
                  {areas.items.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Scheduling
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="all">All schedules</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="flexible">Flexible</option>
                </select>
              </label>
              <label className="loop-check">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Show archived
              </label>
            </div>
            <div className="loop-active-list">
              {visible.map((l) => {
                const existing = currentWork(l);
                const action = existing
                  ? existing.author === currentUser
                    ? 'Continue'
                    : 'View work'
                  : 'Start loop';
                return (
                  <article
                    className={`work-surface loop-active-row${l.archived ? ' is-archived' : ''}`}
                    key={l.id}
                  >
                    <div className="loop-active-copy">
                      <div className="loop-active-title">
                        <button className="loop-card-title" onClick={() => open(l)}>
                          <h3>{l.name}</h3>
                        </button>
                        {!!l.archived && <span className="loop-state-badge">Archived</span>}
                      </div>
                      <p className="loop-active-schedule">
                        {l.mode === 'scheduled'
                          ? `${l.frequency[0].toUpperCase()}${l.frequency.slice(1)} · ${l.nextDue ? `${l.nextDue < l.today ? 'Overdue' : l.nextDue === l.today ? 'Due today' : 'Next due'}: ${l.nextDue}` : 'No deadlines in the next six weeks'}`
                          : `${l.target} per ${l.frequency === 'daily' ? 'day' : l.frequency === 'weekly' ? 'week' : 'month'} · ${l.stats.progress} completed this ${l.frequency === 'daily' ? 'day' : l.frequency === 'weekly' ? 'week' : 'month'}`}
                      </p>
                      <p className="loop-active-owner">
                        {name(l.owner_id)} · {areaName(l.area_id)}
                      </p>
                    </div>
                    <div className="loop-card-actions">
                      <button className="loop-open-link" onClick={() => open(l)}>
                        Details <ArrowUpRight size={15} aria-hidden="true" />
                      </button>
                      {!l.archived && (
                        <button
                          className="work-primary"
                          disabled={busy || (l.mode === 'scheduled' && !l.nextDue)}
                          onClick={() => startFromCard(l)}
                          aria-label={`${existing ? action : 'Start'} ${l.name}`}
                        >
                          <Play size={14} aria-hidden="true" />
                          {action}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {!visible.length && (
              <p className="work-empty">
                {data.items.length
                  ? 'No loops match these filters.'
                  : 'No loops yet. Create a loop to start tracking recurring work.'}
              </p>
            )}
          </section>
        </>
      )}
      {loop && (
        <>
          <div className="loop-inline loop-detail-toolbar">
            {loop.canManage && (
              <>
                <button disabled={busy} onClick={() => edit(loop)}>
                  Edit Loop
                </button>
                <button
                  disabled={busy}
                  onClick={() => void mutate('archive', { id: loop.id, archived: !loop.archived })}
                >
                  {loop.archived ? 'Restore' : 'Archive'}
                </button>
              </>
            )}
            <span>
              {loop.mode === 'scheduled' ? 'Scheduled deadlines' : 'Flexible target'} ·{' '}
              {loop.frequency} · {loop.timezone}
            </span>
          </div>
          {occurrence && (
            <div
              className="loop-selected-occurrence"
              ref={selectedOccurrenceRef}
              tabIndex={-1}
              aria-label="Current occurrence"
            >
              <OccurrenceDetail
                key={occurrence.id}
                occurrence={occurrence}
                loop={loop}
                currentUser={currentUser}
                teamId={teamId}
                busy={busy}
                mutate={mutate}
                onOpenTask={onOpenTask}
                onRetry={() =>
                  void start(loop, occurrence.id, occurrence.due_day, occurrence.agent_id)
                }
              />
            </div>
          )}
          <LoopInsights
            loop={loop}
            history={history}
            onDay={(day) => {
              setDueDay(day);
              const o = history.find((o) => o.due_day === day);
              setSelected(o?.id || '');
            }}
          />
          {!loop.archived && (
            <section className="loop-form loop-work-panel">
              <span className="work-eyebrow">Next action</span>
              <h3>Work on this Loop</h3>
              {loop.mode === 'scheduled' && (
                <label>
                  Deadline
                  <select
                    value={dueDay}
                    onChange={(e) => {
                      setDueDay(e.target.value);
                      setSelected(history.find((o) => o.due_day === e.target.value)?.id || '');
                    }}
                  >
                    <option value="">Choose deadline</option>
                    {loop.slots.map((s) => (
                      <option key={s.day} value={s.day}>
                        {s.day} · {s.state}
                        {s.late ? ' late' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Work with
                <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                  <option value="">Human teammate</option>
                  {loop.agents.map((id) => (
                    <option key={id} value={id}>
                      {agents.find((a) => a.id === id)?.name || id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="work-primary"
                disabled={busy || (loop.mode === 'scheduled' && !dueDay)}
                onClick={() => {
                  const o = history.find((o) => o.due_day === dueDay && dueDay);
                  if (o) setSelected(o.id);
                  else void start(loop);
                }}
              >
                {history.some((o) => dueDay && o.due_day === dueDay)
                  ? 'Open occurrence'
                  : agent
                    ? 'Prepare agent handoff'
                    : 'Start occurrence'}
              </button>
              {loop.mode === 'scheduled' &&
                loop.canManage &&
                dueDay &&
                dueDay <= loop.today &&
                !history.some((o) => o.due_day === dueDay) && (
                  <details>
                    <summary>Skip this deadline</summary>
                    <label>
                      Reason
                      <textarea
                        maxLength={10000}
                        value={skipReason}
                        onChange={(e) => setSkipReason(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy || !skipReason.trim()}
                      onClick={() =>
                        void mutate('skip', {
                          loopId: loop.id,
                          requestId: crypto.randomUUID(),
                          agentId: '',
                          dueDay,
                          note: skipReason,
                        })
                      }
                    >
                      Record skip
                    </button>
                  </details>
                )}
              <p className="loop-help">
                The owner stays accountable. The person starting an occurrence is its contributor.
                No agent runs automatically.
              </p>
            </section>
          )}
          <section className="loop-history-panel work-surface">
            <div className="loop-section-heading">
              <span className="work-eyebrow">Work over time</span>
              <h3>Occurrence history</h3>
            </div>
            <div className="loop-history">
              {history.map((o) => (
                <button
                  className={selected === o.id ? 'is-selected' : ''}
                  aria-pressed={selected === o.id}
                  key={o.id}
                  onClick={() => setSelected(o.id)}
                >
                  <strong>
                    {o.due_day ? `Due ${o.due_day}` : o.period} · {o.state}
                  </strong>
                  <span>
                    Contributor: {name(o.author)} · Owner: {name(o.owner_id)} · {o.area_name}
                  </span>
                  <small>
                    {o.completed_at
                      ? new Date(o.completed_at).toLocaleString()
                      : new Date(o.created_at).toLocaleString()}
                  </small>
                </button>
              ))}
            </div>
            {!history.length && (
              <p className="loop-help">
                No occurrences yet. Start work on this Loop to begin its history.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
