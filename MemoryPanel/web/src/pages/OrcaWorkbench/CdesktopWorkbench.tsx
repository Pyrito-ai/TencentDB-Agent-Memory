import { useCallback, useEffect, useState } from 'react';
import { PanelsTopLeft, RefreshCw } from 'lucide-react';
import { boardTaskUrl, requestedTask } from './api';
import {
  CdesktopTaskHandoff,
  type CdesktopHandoff,
  type CdesktopOptions,
} from './CdesktopTaskHandoff';
import { TaskPicker } from './TaskPicker';
import { updateWorkbenchQuery } from './RuntimePicker';
import { RuntimeGatewayFrame } from './RuntimeGatewayFrame';
import { gatewaySessionIdentity } from './runtimeGateway';
import { SessionHistory } from './SessionHistory';

// The saved receipt names the native session. Only embed it on the configured runtime origin.
function sessionFrameUrl(handoff: CdesktopHandoff | null, options?: CdesktopOptions) {
  const receiptUrl = handoff?.receipt?.webUrl;
  const bindingUrl = options?.bindings.find((binding) => binding.id === handoff?.binding)?.webUrl;
  if (!receiptUrl || !bindingUrl) return undefined;
  try {
    const url = new URL(receiptUrl);
    const configured = new URL(bindingUrl);
    return url.origin === configured.origin &&
      url.origin !== window.location.origin &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function CdesktopWorkbench({ team }: { team: string }) {
  const [taskId, setTaskId] = useState(requestedTask);
  useEffect(() => {
    const changed = () => setTaskId(requestedTask());
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    window.addEventListener('workbench-query-change', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
      window.removeEventListener('workbench-query-change', changed);
    };
  }, []);
  const [historyVersion, setHistoryVersion] = useState(0);
  const sessionChanged = useCallback(() => setHistoryVersion((value) => value + 1), []);
  return (
    <div className="cdesktop-layout">
      <SessionHistory
        team={team}
        taskId={taskId}
        version={historyVersion}
        onSelect={(id) => updateWorkbenchQuery({ task: id })}
      />
      <CdesktopSession key={taskId} team={team} taskId={taskId} onChange={sessionChanged} />
    </div>
  );
}

function CdesktopSession({
  team,
  taskId,
  onChange,
}: {
  team: string;
  taskId: string;
  onChange: () => void;
}) {
  const [handoff, setHandoff] = useState<CdesktopHandoff | null>(null);
  const [options, setOptions] = useState<CdesktopOptions>();
  const [frameVersion, setFrameVersion] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const receiveHandoff = useCallback(
    (next: CdesktopHandoff | null, opts: CdesktopOptions) => {
      setHandoff(next);
      setOptions(opts);
      if (next) onChange();
    },
    [onChange],
  );
  const gatewayConfigured = options?.browserGateway !== undefined;
  // An unavailable gateway must never downgrade to a saved local runtime URL.
  const frameUrl = gatewayConfigured ? undefined : sessionFrameUrl(handoff, options);
  const gatewaySession = gatewayConfigured && !!handoff?.receipt;
  const hasFrame = gatewaySession || !!frameUrl;
  const reload = () => setFrameVersion((value) => value + 1);
  return (
    <div className="native-workbench cdesktop-workbench">
      <section className="native-orca" aria-label="cdesktop workspace">
        <header className="native-orca-toolbar">
          <strong>cdesktop</strong>
          {gatewayConfigured && <span>Development previews are not available here yet.</span>}
          {taskId && <a href={boardTaskUrl(taskId)}>Back to task</a>}
          <div />
          {handoff && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              {detailsOpen ? 'Hide handoff' : 'Session details'}
            </button>
          )}
          {hasFrame && (
            <button type="button" aria-label="Reload cdesktop interface" onClick={reload}>
              <RefreshCw size={14} />
            </button>
          )}
        </header>
        {!taskId && (
          <div className="cdesktop-task-picker">
            <TaskPicker
              team={team}
              taskId=""
              disabled={false}
              onSelect={(id) => updateWorkbenchQuery({ task: id })}
            />
          </div>
        )}
        {taskId && (
          <div className="cdesktop-handoff-panel" hidden={hasFrame && !detailsOpen}>
            <CdesktopTaskHandoff team={team} taskId={taskId} embedded onHandoff={receiveHandoff} />
          </div>
        )}
        {gatewaySession && handoff ? (
          <RuntimeGatewayFrame
            key={`${gatewaySessionIdentity(handoff)}:${options?.browserGateway?.origin}:${frameVersion}`}
            team={team}
            taskId={taskId}
            origin={options?.browserGateway?.origin || ''}
            onReconnect={reload}
          />
        ) : frameUrl ? (
          <iframe
            key={`${handoff?.receipt?.sessionId || handoff?.id}:${frameVersion}`}
            title="cdesktop native session interface"
            src={frameUrl}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
          />
        ) : (
          <div className="orca-connection-empty">
            <PanelsTopLeft size={28} aria-hidden="true" />
            <strong>
              {handoff?.receipt ? 'cdesktop session saved' : 'Open a task in cdesktop'}
            </strong>
            <p>
              {handoff?.receipt
                ? 'The saved session does not have a usable browser URL on its configured runtime. Refresh its status or check the cdesktop connection.'
                : 'Choose a Task Board task and send it to cdesktop. Its native session will open here.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
