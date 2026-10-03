export type GatewayConnectionState = {
  phase: 'waiting' | 'submitted' | 'ready' | 'timed-out' | 'error';
  submitted: boolean;
  error: string;
};

export const INITIAL_GATEWAY_CONNECTION: GatewayConnectionState = {
  phase: 'waiting',
  submitted: false,
  error: '',
};

/** Named-frame POST navigation leaves src unchanged; inspect the loaded document instead. */
export function isGatewayDocumentLoad(frame: Pick<HTMLIFrameElement, 'contentDocument'>): boolean {
  try {
    const document = frame.contentDocument;
    return (
      document === null ||
      (document.URL !== '' && document.URL !== 'about:blank' && document.URL !== 'about:srcdoc')
    );
  } catch (cause) {
    // Browsers normally return null for a cross-origin document; some deny the getter.
    return cause instanceof DOMException && cause.name === 'SecurityError';
  }
}

/** One mounted attempt. A slow document may recover; an expired grant must never post late. */
export function createGatewayConnection(onChange: (state: GatewayConnectionState) => void) {
  let state = INITIAL_GATEWAY_CONNECTION;
  let disposed = false;
  let scheduled = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (phase: GatewayConnectionState['phase'], error = '') => {
    if (disposed) return;
    clearTimeout(timer);
    state = { ...state, phase, error };
    onChange(state);
  };
  return {
    get phase() {
      return state.phase;
    },
    startGrant(request: () => void): boolean {
      if (disposed || scheduled || state.phase !== 'waiting') return false;
      scheduled = true;
      // The iframe target exists after DOM commit. No about:blank load event or
      // foreground timer is required, and StrictMode cleanup cancels its probe.
      queueMicrotask(() => {
        if (disposed || state.phase !== 'waiting') return;
        started = true;
        timer = setTimeout(
          () => update('error', 'cdesktop did not respond in time. Reconnect to try again.'),
          20_000,
        );
        request();
      });
      return true;
    },
    submit(post: () => void): boolean {
      if (disposed || !started || state.phase !== 'waiting') return false;
      // Mark submitted only when validation and form submission both succeeded.
      post();
      if (disposed) return false;
      clearTimeout(timer);
      state = { phase: 'submitted', submitted: true, error: '' };
      timer = setTimeout(
        () =>
          update(
            'timed-out',
            'cdesktop is taking longer than expected. Keep waiting or reconnect.',
          ),
        45_000,
      );
      onChange(state);
      return true;
    },
    frameLoaded(): void {
      if (state.submitted && (state.phase === 'submitted' || state.phase === 'timed-out')) {
        update('ready');
      }
    },
    fail(message: string): void {
      update('error', message);
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
