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

/** One mounted attempt. A slow document may recover; an expired grant must never post late. */
export function createGatewayConnection(onChange: (state: GatewayConnectionState) => void) {
  let state = INITIAL_GATEWAY_CONNECTION;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const update = (phase: GatewayConnectionState['phase'], error = '') => {
    if (disposed) return;
    clearTimeout(timer);
    state = { ...state, phase, error };
    onChange(state);
  };
  timer = setTimeout(
    () => update('error', 'cdesktop did not respond in time. Reconnect to try again.'),
    20_000,
  );

  return {
    get phase() {
      return state.phase;
    },
    submit(post: () => void): boolean {
      if (disposed || state.phase !== 'waiting') return false;
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
