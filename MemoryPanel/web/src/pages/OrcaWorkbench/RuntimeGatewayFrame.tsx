import { useEffect, useId, useRef, useState } from 'react';
import { PanelsTopLeft } from 'lucide-react';
import { request } from './api';
import {
  BrowserGatewayError,
  browserGatewayBootstrapUrl,
  postBrowserGatewayGrant,
} from './runtimeGateway';
import {
  createGatewayConnection,
  INITIAL_GATEWAY_CONNECTION,
  isGatewayDocumentLoad,
} from './runtimeGatewayConnection';

export function RuntimeGatewayFrame({
  team,
  taskId,
  origin,
  onReconnect,
}: {
  team: string;
  taskId: string;
  origin: string;
  onReconnect: () => void;
}) {
  const name = `cdesktop-${useId().replace(/:/g, '')}`;
  const [state, setState] = useState(INITIAL_GATEWAY_CONNECTION);
  const connection = useRef<ReturnType<typeof createGatewayConnection> | null>(null);

  useEffect(() => {
    const current = createGatewayConnection(setState);
    connection.current = current;
    setState(INITIAL_GATEWAY_CONNECTION);
    let active = true;
    current.startGrant(() => {
      try {
        browserGatewayBootstrapUrl(origin, window.location.origin);
      } catch {
        current.fail(
          'The Workbench connection is not configured correctly. Check the connection and retry.',
        );
        return;
      }
      void request<unknown>(team, 'cdesktop-browser-session', { taskId })
        .then((grant) => {
          if (!active || connection.current !== current) return;
          try {
            current.submit(() =>
              postBrowserGatewayGrant(grant, origin, window.location.origin, name, document),
            );
          } catch (cause) {
            current.fail(
              cause instanceof BrowserGatewayError
                ? cause.message
                : 'The Workbench could not open a secure session. Reconnect to try again.',
            );
          }
        })
        .catch(() => {
          if (active && connection.current === current && current.phase === 'waiting') {
            current.fail(
              'The Workbench is unavailable or your access has changed. Reconnect to try again.',
            );
          }
        });
    });
    return () => {
      active = false;
      current.dispose();
      if (connection.current === current) connection.current = null;
    };
  }, [team, taskId, origin, name]);

  return (
    <>
      {state.phase !== 'ready' && (
        <div
          className={state.submitted ? 'cdesktop-connection-status' : 'orca-connection-empty'}
          role={state.error ? 'alert' : 'status'}
        >
          {!state.submitted && <PanelsTopLeft size={28} aria-hidden="true" />}
          <strong>
            {state.phase === 'timed-out'
              ? 'Still loading the session'
              : state.error
                ? 'Could not connect to the session'
                : 'Connecting to the session…'}
          </strong>
          <p>{state.error || 'Opening your saved session.'}</p>
          {state.error && (
            <button type="button" onClick={onReconnect}>
              Reconnect
            </button>
          )}
        </div>
      )}
      <iframe
        name={name}
        title="Workbench session"
        src="about:blank"
        style={state.submitted ? undefined : { display: 'none' }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        onLoad={(event) => {
          if (isGatewayDocumentLoad(event.currentTarget)) connection.current?.frameLoaded();
        }}
        onError={() =>
          connection.current?.fail('The Workbench could not load. Reconnect to try again.')
        }
      />
    </>
  );
}
