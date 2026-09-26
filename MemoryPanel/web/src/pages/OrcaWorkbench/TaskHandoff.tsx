import { useEffect, useRef, useState } from 'react';
import { request, type Options, type WorkerReceipt } from './api';
import { CdesktopTaskHandoff } from './CdesktopTaskHandoff';
import { RuntimePicker, type WorkbenchRuntime } from './RuntimePicker';
import {
  AgentBundlePreview,
  AgentBundleReceipt,
  type AgentBundleSnapshot,
  type HandoffAgentProfile as AgentProfile,
} from './AgentBundleSummary';
import './workbench.css';

type Handoff = {
  profile?: AgentProfile;
  bundle?: AgentBundleSnapshot;
  id: string;
  spec?: string;
  binding: string;
  agent: 'codex' | 'claude';
  receipt?: WorkerReceipt;
  error?: string;
};
export function TaskHandoff({ team, taskId }: { team: string; taskId: string }) {
  const [runtime, setRuntime] = useState<WorkbenchRuntime>('orca');
  const [visitedCdesktop, setVisitedCdesktop] = useState(false);
  return (
    <div className="task-handoff-runtimes">
      <div className="task-handoff-runtime-heading">
        <strong>Open a work session</strong>
        <RuntimePicker
          runtime={runtime}
          onChange={(next) => {
            setRuntime(next);
            if (next === 'cdesktop') setVisitedCdesktop(true);
          }}
        />
      </div>
      <div hidden={runtime !== 'orca'}>
        <OrcaTaskHandoff team={team} taskId={taskId} />
      </div>
      {visitedCdesktop && (
        <div hidden={runtime !== 'cdesktop'}>
          <CdesktopTaskHandoff team={team} taskId={taskId} />
        </div>
      )}
    </div>
  );
}

function OrcaTaskHandoff({ team, taskId }: { team: string; taskId: string }) {
  const [options, setOptions] = useState<Options>();
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [binding, setBinding] = useState('');
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectRuntime, setProjectRuntime] = useState('');
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<Options>(team, 'options'),
      request<{ items: AgentProfile[] }>(team, 'handoff-profiles'),
      request<{ handoff: Handoff | null }>(team, 'handoff-get', { taskId }),
    ])
      .then(([opts, catalog, result]) => {
        if (active) setProfiles(catalog.items);
        if (!active) return;
        setOptions(opts);
        setHandoff(result.handoff);
        setLoaded(true);
        if (result.handoff) {
          setBinding(result.handoff.binding);
          setAgent(result.handoff.agent);
          setProfileId(result.handoff.profile?.id || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team, taskId]);
  async function act(action: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ handoff: Handoff | null }>(team, action, {
        taskId,
        binding,
        agent,
        ...(profileId ? { profileId } : {}),
      });
      setHandoff(result.handoff);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach Orca.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function createProject() {
    if (lock.current || handoff) return;
    const runtime = projectRuntime || options?.projectRuntimes?.[0]?.id;
    if (!runtime || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,59}$/.test(projectName.trim())) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const project = await request<{ binding: string; name: string }>(team, 'project-create', {
        runtime,
        name: projectName.trim(),
      });
      setOptions(
        (current) =>
          current && {
            ...current,
            bindings: [
              ...current.bindings.filter((b) => b.id !== project.binding),
              {
                id: project.binding,
                label: project.name,
                webUrl: current.bindings.find((b) => b.id === runtime)?.webUrl,
              },
            ],
          },
      );
      setBinding(project.binding);
      setCreatingProject(false);
      setProjectName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the Orca project.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const selectedProfile = handoff?.profile || profiles.find((profile) => profile.id === profileId);
  return (
    <section className="task-execution" aria-label="Send task to Orca">
      <div className="task-execution-heading">
        <strong>Send to Orca</strong>
        <a href={`/#/workbench?task=${encodeURIComponent(taskId)}`}>Open Workbench</a>
      </div>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading Orca projects…</p>}
      {loaded && (
        <>
          <label>
            Orca project
            <select
              aria-label="Orca project"
              value={creatingProject ? '__new_project__' : binding}
              disabled={busy || !!handoff}
              onChange={(e) => {
                setCreatingProject(e.target.value === '__new_project__');
                setError('');
                if (e.target.value !== '__new_project__') setBinding(e.target.value);
              }}
            >
              <option value="">Choose a project</option>
              {!!options?.projectRuntimes?.length && (
                <option value="__new_project__">New project…</option>
              )}
              {options?.bindings
                .filter((b) => !options.projectRuntimes?.some((r) => r.id === b.id))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
            </select>
          </label>
          {creatingProject && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createProject();
              }}
            >
              <label>
                Project name
                <input
                  aria-label="New Orca project name"
                  autoFocus
                  value={projectName}
                  maxLength={60}
                  disabled={busy}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. pyrito-website"
                />
              </label>
              {(options?.projectRuntimes?.length || 0) > 1 && (
                <label>
                  Runtime
                  <select
                    aria-label="New project runtime"
                    value={projectRuntime || options?.projectRuntimes?.[0]?.id}
                    disabled={busy}
                    onChange={(e) => setProjectRuntime(e.target.value)}
                  >
                    {options?.projectRuntimes?.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <small>
                Creates a local Git project in Orca. Use 2–60 letters, numbers, spaces, underscores
                or hyphens.
              </small>
              <div>
                <button
                  type="submit"
                  disabled={busy || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,59}$/.test(projectName.trim())}
                >
                  {busy ? 'Creating…' : 'Create project'}
                </button>{' '}
                <button type="button" disabled={busy} onClick={() => setCreatingProject(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          <label>
            Agent
            <select
              aria-label="Orca agent"
              value={agent}
              disabled={busy || !!handoff}
              onChange={(e) => setAgent(e.target.value as 'codex' | 'claude')}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            Agent profile
            <select
              aria-label="Agent profile"
              value={profileId}
              disabled={busy || !!handoff}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">No profile — task instructions only</option>
              {profiles
                .filter((p) => p.id !== handoff?.profile?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              {handoff?.profile && (
                <option value={handoff.profile.id}>{handoff.profile.name} (saved at launch)</option>
              )}
            </select>
          </label>
          {!handoff && (
            <small>
              {selectedProfile && (
                <>
                  {selectedProfile.bundle
                    ? 'Uses the role, rules and package from '
                    : 'Uses the role and rules from '}
                  <a href="#/agents">Agents</a>.{' '}
                </>
              )}
              Tool connections and model settings remain configured in Orca.
            </small>
          )}
          {!handoff && <AgentBundlePreview bundle={selectedProfile?.bundle} />}
          {(() => {
            const selected = selectedProfile;
            return (
              selected && (
                <details>
                  <summary>Profile instructions</summary>
                  <p>{selected.description}</p>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                    {selected.prompt ||
                      'This profile has no role or rules yet. Add them on the Agents page.'}
                  </pre>
                </details>
              )
            );
          })()}
          {!handoff && (
            <>
              <p>
                Sends the task brief, project context and linked Wiki excerpts to a new worktree.
                Uses the agent account configured in Orca.
              </p>
              <button
                disabled={busy || !binding || creatingProject}
                onClick={() => void act('handoff-launch')}
              >
                {busy ? 'Sending…' : 'Send to Orca'}
              </button>
            </>
          )}
          {handoff && (
            <>
              <p role="status">
                {handoff.receipt
                  ? handoff.receipt.state === 'running'
                    ? 'Orca session open — check progress in Orca'
                    : 'Check the saved session in Orca'
                  : 'Handoff awaiting confirmation'}
              </p>
              {handoff.spec && (
                <details>
                  <summary>Instructions and context sent</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
                    {handoff.spec}
                  </pre>
                </details>
              )}
              <AgentBundleReceipt
                bundle={handoff.bundle}
                sent={handoff.receipt?.state === 'running' || handoff.receipt?.state === 'exited'}
              />
              {handoff.error && <p role="alert">{handoff.error}</p>}
              {handoff.receipt?.worktree && <p>Worktree: {handoff.receipt.worktree}</p>}
              {handoff.receipt?.notice && <p>{handoff.receipt.notice}</p>}
              <details className="handoff-receipt">
                <summary>Orca session receipt</summary>
                <dl>
                  <dt>Handoff</dt>
                  <dd>{handoff.id}</dd>
                  {handoff.receipt?.id && (
                    <>
                      <dt>Receipt</dt>
                      <dd>{handoff.receipt.id}</dd>
                    </>
                  )}
                  {handoff.receipt?.native?.runId && (
                    <>
                      <dt>Run</dt>
                      <dd>{handoff.receipt.native.runId}</dd>
                    </>
                  )}
                  {handoff.receipt?.native?.taskId && (
                    <>
                      <dt>Task</dt>
                      <dd>{handoff.receipt.native.taskId}</dd>
                    </>
                  )}
                  {handoff.receipt?.native?.dispatchId && (
                    <>
                      <dt>Dispatch</dt>
                      <dd>{handoff.receipt.native.dispatchId}</dd>
                    </>
                  )}
                </dl>
              </details>
              {!handoff.receipt && (
                <button disabled={busy} onClick={() => void act('handoff-launch')}>
                  Retry saved handoff
                </button>
              )}
              <button disabled={busy} onClick={() => void act('handoff-sync')}>
                Refresh Orca status
              </button>
              <small>
                Continue in Orca. Task Board status stays manual; this does not merge or deploy.
              </small>
            </>
          )}
        </>
      )}
    </section>
  );
}
