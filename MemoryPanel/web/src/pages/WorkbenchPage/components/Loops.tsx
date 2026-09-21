import { useEffect, useState } from 'react';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { useProjects } from '../hooks/useProjects';
import { useAreas, workApi as api } from '../hooks/useAreas';
import Areas from './Areas';
import OccurrenceDetail from './OccurrenceDetail';
import LoopInsights from './LoopInsights';
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
    if (result?.occurrence) setSelected(result.occurrence.id);
    else setVersion((v) => v + 1);
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
      <header>
        <div>
          {detail && (
            <button
              onClick={() => {
                setDetail('');
                setForm(null);
              }}
            >
              ← All Loops
            </button>
          )}
          <h2>{loop?.name || 'Loops'}</h2>
          <p>
            {loop
              ? `${areaName(loop.area_id)} · Owner: ${name(loop.owner_id)}`
              : 'Recurring responsibilities, with a clear owner and a home in an Area.'}
          </p>
        </div>
        <div className="loop-inline">
          <button onClick={() => setManageAreas((v) => !v)}>Manage Areas</button>
          <button disabled={busy} onClick={() => edit()}>
            New Loop
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setVersion((v) => v + 1);
              areas.reload();
            }}
          >
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
      {!data && !error && <p role="status">Loading Loops…</p>}
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
          <h3>{editing ? 'Edit Loop' : 'New Loop'}</h3>
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
            <button disabled={busy || !form.areaId}>Save Loop</button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {data && !loop && (
        <>
          <div className="loop-filter-panel">
            <h3>Dashboard filters</h3>
            <div className="loop-inline">
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
          </div>
          <div className="loop-metrics">
            {[
              ['Loops', visible.length],
              ['Active streaks', visible.filter((l) => l.stats.currentStreak > 0).length],
              ['Overdue deadlines', visible.reduce((n, l) => n + l.overdue, 0)],
              ['Total completions', visible.reduce((n, l) => n + l.stats.total, 0)],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <div className="loop-cards">
            {visible.map((l) => (
              <article key={l.id}>
                <button className="loop-card-title" onClick={() => open(l)}>
                  <h3>
                    {l.name}
                    {!!l.archived && ' · Archived'}
                  </h3>
                </button>
                <p>
                  {l.mode === 'scheduled'
                    ? `Scheduled ${l.frequency} · Next unresolved: ${l.nextDue || 'None in next six weeks'}`
                    : `${l.target} per ${l.frequency === 'daily' ? 'day' : l.frequency === 'weekly' ? 'week' : 'month'} · Flexible`}
                </p>
                <dl>
                  <dt>Owner</dt>
                  <dd>{name(l.owner_id)}</dd>
                  <dt>Area</dt>
                  <dd>{areaName(l.area_id)}</dd>
                </dl>
                <progress
                  aria-label={`${l.name} period progress`}
                  value={Math.min(l.stats.progress, l.target)}
                  max={l.target}
                />
                <p>
                  {l.stats.progress} / {l.target} this period
                </p>
                <LoopInsights
                  loop={l}
                  history={data.history.filter((o) => o.loop_id === l.id)}
                  compact
                />
                <div className="loop-card-footer">
                  <span>{l.stats.currentStreak} streak</span>
                  <span>{l.stats.bestStreak} best</span>
                  <span>{l.stats.total} done</span>
                </div>
                <button onClick={() => open(l)}>Open Loop</button>
              </article>
            ))}
          </div>
          {!visible.length && (
            <p>
              No Loops match these filters. Create an Area and its first recurring responsibility to
              get started.
            </p>
          )}
        </>
      )}
      {loop && (
        <>
          <div className="loop-inline">
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
            <section className="loop-form">
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
          <h3>Occurrence history</h3>
          <div className="loop-history">
            {history.map((o) => (
              <button
                className={selected === o.id ? 'is-selected' : ''}
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
          {occurrence && (
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
          )}
        </>
      )}
    </section>
  );
}
