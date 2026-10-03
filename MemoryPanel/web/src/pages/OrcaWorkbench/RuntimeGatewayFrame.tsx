import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PanelsTopLeft } from 'lucide-react';
import { request } from './api';
import {
  BrowserGatewayError,
  browserGatewayBootstrapUrl,
  postBrowserGatewayGrant,
} from './runtimeGateway';

const CONNECTION_TIMEOUT_MS = 20_000;

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
  const [frameReady, setFrameReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const phase = useRef<'waiting' | 'submitted' | 'ready' | 'error'>('waiting');
  const timeout = useRef<ReturnType<typeof setTimeout>>();
  const fail = useCallback((message: string) => {
    phase.current = 'error';
    clearTimeout(timeout.current);
    setConnected(false);
    setError(message);
  }, []);

  useEffect(() => {
    timeout.current = setTimeout(
      () => fail('cdesktop did not respond in time. Reconnect to try again.'),
      CONNECTION_TIMEOUT_MS,
    );
    return () => clearTimeout(timeout.current);
  }, [fail]);

  useEffect(() => {
    if (!frameReady) return;
    let active = true;
    // Deferring the mutation allows StrictMode's setup/cleanup probe to cancel it.
    // There is no grant cache: every mounted connection or manual retry gets a new grant.
    const start = setTimeout(() => {
      if (phase.current !== 'waiting') return;
      try {
        browserGatewayBootstrapUrl(origin, window.location.origin);
      } catch {
        fail(
          'The cdesktop connection is not configured correctly. Check the connection and retry.',
        );
        return;
      }
      void request<unknown>(team, 'cdesktop-browser-session', { taskId })
        .then((grant) => {
          if (!active || phase.current !== 'waiting') return;
          // The initial about:blank load has already finished. Only a subsequent
          // load after the POST may reveal the native session (or its error page).
          phase.current = 'submitted';
          try {
            postBrowserGatewayGrant(grant, origin, window.location.origin, name, document);
          } catch (cause) {
            fail(
              cause instanceof BrowserGatewayError
                ? cause.message
                : 'cdesktop could not open a secure session. Reconnect to try again.',
            );
          }
        })
        .catch(() => {
          if (active && phase.current === 'waiting') {
            fail('cdesktop is unavailable or your access has changed. Reconnect to try again.');
          }
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(start);
    };
  }, [frameReady, team, taskId, origin, name, fail]);

  return (
    <>
      {!connected && (
        <div className="orca-connection-empty" role={error ? 'alert' : 'status'}>
          <PanelsTopLeft size={28} aria-hidden="true" />
          <strong>{error ? 'Could not connect to cdesktop' : 'Connecting to cdesktop…'}</strong>
          <p>{error || 'Opening your saved session.'}</p>
          {error && (
            <button type="button" onClick={onReconnect}>
              Reconnect to cdesktop
            </button>
          )}
        </div>
      )}
      <iframe
        name={name}
        title="cdesktop native session interface"
        src="about:blank"
        style={connected ? undefined : { display: 'none' }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        onLoad={() => {
          if (phase.current === 'waiting') setFrameReady(true);
          else if (phase.current === 'submitted') {
            phase.current = 'ready';
            clearTimeout(timeout.current);
            setConnected(true);
          }
        }}
        onError={() => fail('cdesktop could not load. Reconnect to try again.')}
      />
    </>
  );
}
