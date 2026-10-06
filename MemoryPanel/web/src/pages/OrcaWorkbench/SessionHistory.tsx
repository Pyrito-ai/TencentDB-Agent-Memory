import { useCallback, useEffect, useState } from 'react';
import { History, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw } from 'lucide-react';
import { request } from './api';

export type SessionSummary = {
  id: string;
  taskId: string;
  taskTitle: string;
  agent: 'codex' | 'claude';
  bindingLabel: string;
  profileName?: string;
  state: string;
  status: 'active' | 'completed' | 'attention';
  error?: string;
  created?: number;
  updated?: number;
};

const GROUPS: { status: SessionSummary['status']; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'attention', label: 'Needs attention' },
  { status: 'completed', label: 'Completed' },
];

const STATE_LABELS: Record<string, string> = {
  pending: 'Not launched',
  launching: 'Starting',
  running: 'Running',
  exited: 'Ended',
  unknown: 'Status uncertain',
};

const COLLAPSED_KEY = 'pyrito.workbench.sessionsCollapsed';

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function when(time?: number) {
  if (!time) return '';
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Saved cdesktop sessions for this user, so past and running chats stay one click away. */
export function SessionHistory({
  team,
  taskId,
  version,
  onSelect,
}: {
  team: string;
  taskId: string;
  version: number;
  onSelect: (taskId: string) => void;
}) {
  const [items, setItems] = useState<SessionSummary[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1');
      } catch {
        /* preference is per-browser convenience only */
      }
      return !value;
    });
  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      try {
        const result = await request<{ items: SessionSummary[] }>(
          team,
          `cdesktop-handoff-list${refresh ? '?refresh=1' : ''}`,
        );
        setItems(result.items);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load sessions.');
      } finally {
        setBusy(false);
      }
    },
    [team],
  );
  useEffect(() => {
    void load(version === 0);
  }, [load, version, taskId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (collapsed)
    return (
      <nav className="cdesktop-history is-collapsed" aria-label="cdesktop sessions">
        <button type="button" aria-label="Show sessions" title="Show sessions" onClick={toggle}>
          <PanelLeftOpen size={14} />
        </button>
        <button
          type="button"
          aria-label="New session"
          title="New session"
          onClick={() => onSelect('')}
        >
          <Plus size={13} />
        </button>
        {items?.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.taskTitle || item.taskId}
            title={`${item.taskTitle || item.taskId} · ${STATE_LABELS[item.state] || item.state}`}
            aria-current={item.taskId === taskId ? 'true' : undefined}
            onClick={() => onSelect(item.taskId)}
          >
            <span className={`cdesktop-history-dot is-${item.status}`} aria-hidden="true" />
          </button>
        ))}
      </nav>
    );
  return (
    <nav className="cdesktop-history" aria-label="cdesktop sessions">
      <header>
        <History size={14} aria-hidden="true" />
        <strong>Sessions</strong>
        <button
          type="button"
          aria-label="Refresh session status"
          title="Refresh session status"
          disabled={busy}
          onClick={() => void load(true)}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          aria-label="New session"
          title="New session"
          aria-pressed={!taskId}
          onClick={() => onSelect('')}
        >
          <Plus size={13} />
        </button>
        <button type="button" aria-label="Hide sessions" title="Hide sessions" onClick={toggle}>
          <PanelLeftClose size={13} />
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p>Loading sessions…</p>}
      {items && !items.length && (
        <p>No sessions yet. Choose a task and send it to cdesktop to start one.</p>
      )}
      {items &&
        GROUPS.map(({ status, label }) => {
          const group = items.filter((item) => item.status === status);
          if (!group.length) return null;
          return (
            <section key={status}>
              <h3>
                {label} <span>{group.length}</span>
              </h3>
              <ul>
                {group.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={item.taskId === taskId ? 'true' : undefined}
                      onClick={() => onSelect(item.taskId)}
                    >
                      <span
                        className={`cdesktop-history-dot is-${item.status}`}
                        aria-hidden="true"
                      />
                      <span className="cdesktop-history-title">
                        {item.taskTitle || item.taskId}
                      </span>
                      <small>
                        {item.agent === 'codex' ? 'Codex' : 'Claude'} ·{' '}
                        {STATE_LABELS[item.state] || item.state}
                        {item.updated ? ` · ${when(item.updated)}` : ''}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
    </nav>
  );
}
