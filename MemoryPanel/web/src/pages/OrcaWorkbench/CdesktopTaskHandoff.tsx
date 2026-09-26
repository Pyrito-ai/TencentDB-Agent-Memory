import { useEffect, useRef, useState } from 'react';
import { request, executionLabel, type Binding } from './api';
import { workbenchUrl } from './RuntimePicker';
import {
  AgentBundlePreview,
  AgentBundleReceipt,
  type AgentBundleSnapshot,
  type HandoffAgentProfile as AgentProfile,
} from './AgentBundleSummary';

export type CdesktopOptions = { bindings: Binding[]; ready: boolean };
export type CdesktopHandoff = {
  id: string;
  binding: string;
  agent: 'codex' | 'claude';
  profile?: AgentProfile;
  bundle?: AgentBundleSnapshot;
  spec: string;
  receipt?: {
    id: string;
    state: string;
    worktree?: string;
    sessionId?: string;
    workspaceId?: string;
    webUrl?: string;
    notice?: string;
  };
  error?: string;
};

export function CdesktopTaskHandoff({
  team,
  taskId,
  embedded = false,
  onHandoff,
}: {
  team: string;
  taskId: string;
  embedded?: boolean;
  onHandoff?: (handoff: CdesktopHandoff | null, options: CdesktopOptions) => void;
}) {
  const [options, setOptions] = useState<CdesktopOptions>();
  const [handoff, setHandoff] = useState<CdesktopHandoff | null>(null);
  const [binding, setBinding] = useState('');
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex');
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([
      request<CdesktopOptions>(team, 'cdesktop-options'),
      request<{ items: AgentProfile[] }>(team, 'handoff-profiles'),
      request<{ handoff: CdesktopHandoff | null }>(team, 'cdesktop-handoff-get', { taskId }),
    ])
      .then(([opts, catalog, result]) => {
        if (!active) return;
        setOptions(opts);
        setProfiles(catalog.items);
        setHandoff(result.handoff);
        setLoaded(true);
        if (result.handoff) {
          setBinding(result.handoff.binding);
          setAgent(result.handoff.agent);
          setProfileId(result.handoff.profile?.id || '');
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not load cdesktop.');
      });
    return () => {
      active = false;
    };
  }, [team, taskId, loadVersion]);
  useEffect(() => {
    if (options && loaded) onHandoff?.(handoff, options);
  }, [handoff, options, loaded, onHandoff]);

  async function act(action: 'cdesktop-handoff-launch' | 'cdesktop-handoff-sync') {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ handoff: CdesktopHandoff | null }>(team, action, {
        taskId,
        ...(action === 'cdesktop-handoff-launch'
          ? { binding, agent, ...(profileId ? { profileId } : {}) }
          : {}),
      });
      setHandoff(result.handoff);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach cdesktop.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const selectedProfile = handoff?.profile || profiles.find((profile) => profile.id === profileId);
  return (
    <section className="task-execution cdesktop-handoff" aria-label="Send task to cdesktop">
      <div className="task-execution-heading">
        <strong>
          {handoff ? 'cdesktop session' : 'Send to cdesktop'}{' '}
          <small className="runtime-trial">trial</small>
        </strong>
        {!embedded && <a href={workbenchUrl('cdesktop', taskId)}>Open Workbench</a>}
      </div>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading cdesktop projects…</p>}
      {!loaded && error && (
        <button type="button" onClick={() => setLoadVersion((value) => value + 1)}>
          Retry connection
        </button>
      )}
      {loaded && !handoff && (
        <>
          {!options?.ready || !options.bindings.length ? (
            <p>
              cdesktop is not connected for this team yet. Configure a cdesktop project to try it
              here.
            </p>
          ) : (
            <>
              <label>
                cdesktop project
                <select
                  aria-label="cdesktop project"
                  value={binding}
                  disabled={busy}
                  onChange={(event) => setBinding(event.target.value)}
                >
                  <option value="">Choose a project</option>
                  {options.bindings.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Agent
                <select
                  aria-label="cdesktop agent"
                  value={agent}
                  disabled={busy}
                  onChange={(event) => setAgent(event.target.value as 'codex' | 'claude')}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                Agent profile
                <select
                  aria-label="cdesktop agent profile"
                  value={profileId}
                  disabled={busy}
                  onChange={(event) => setProfileId(event.target.value)}
                >
                  <option value="">No profile — task instructions only</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                {selectedProfile && (
                  <>
                    {selectedProfile.bundle
                      ? 'Uses the role, rules and package from '
                      : 'Uses the role and rules from '}
                    <a href="#/agents">Agents</a>.{' '}
                  </>
                )}
                Tool connections, account and model settings come from cdesktop.
              </small>
              <AgentBundlePreview bundle={selectedProfile?.bundle} />
              {selectedProfile && (
                <details>
                  <summary>Profile instructions</summary>
                  <p>{selectedProfile.description}</p>
                  <pre>
                    {selectedProfile.prompt ||
                      'This profile has no role or rules yet. Add them on the Agents page.'}
                  </pre>
                </details>
              )}
              <p>
                Sends the task brief, project context and linked Wiki excerpts to a new cdesktop
                worktree.
              </p>
              <button
                type="button"
                disabled={busy || !binding}
                onClick={() => void act('cdesktop-handoff-launch')}
              >
                {busy ? 'Sending…' : 'Send to cdesktop'}
              </button>
            </>
          )}
        </>
      )}
      {handoff && (
        <>
          <p role="status">
            {handoff.receipt
              ? executionLabel(handoff.receipt.state)
              : 'Handoff awaiting confirmation'}
          </p>
          <small>
            {options?.bindings.find((item) => item.id === handoff.binding)?.label ||
              handoff.binding}{' '}
            · {handoff.agent === 'codex' ? 'Codex' : 'Claude'}
            {handoff.profile ? ` · ${handoff.profile.name} (saved at launch)` : ''}
          </small>
          {handoff.error && <p role="alert">{handoff.error}</p>}
          {handoff.receipt?.notice && <p>{handoff.receipt.notice}</p>}
          {handoff.spec && (
            <details>
              <summary>Instructions and context sent</summary>
              <pre>{handoff.spec}</pre>
            </details>
          )}
          <AgentBundleReceipt
            bundle={handoff.bundle}
            sent={handoff.receipt?.state === 'running' || handoff.receipt?.state === 'exited'}
          />
          <details className="handoff-receipt">
            <summary>cdesktop session receipt</summary>
            <dl>
              <dt>Handoff</dt>
              <dd>{handoff.id}</dd>
              {handoff.receipt && (
                <>
                  <dt>Receipt</dt>
                  <dd>{handoff.receipt.id}</dd>
                </>
              )}
              {handoff.receipt?.sessionId && (
                <>
                  <dt>Session</dt>
                  <dd>{handoff.receipt.sessionId}</dd>
                </>
              )}
              {handoff.receipt?.workspaceId && (
                <>
                  <dt>Workspace</dt>
                  <dd>{handoff.receipt.workspaceId}</dd>
                </>
              )}
              {handoff.receipt?.worktree && (
                <>
                  <dt>Worktree</dt>
                  <dd>{handoff.receipt.worktree}</dd>
                </>
              )}
            </dl>
          </details>
          <div className="handoff-actions">
            {!handoff.receipt && (
              <button
                type="button"
                disabled={busy || !options?.ready}
                onClick={() => void act('cdesktop-handoff-launch')}
              >
                Retry saved handoff
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void act('cdesktop-handoff-sync')}>
              {busy ? 'Refreshing…' : 'Refresh cdesktop status'}
            </button>
          </div>
          <small>
            Continue in the cdesktop session. Task Board status stays manual; this does not merge or
            deploy.
          </small>
        </>
      )}
    </section>
  );
}
