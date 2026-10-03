import type { CdesktopHandoff } from './CdesktopTaskHandoff';

export type BrowserGatewayGrant = {
  bootstrapUrl: string;
  ticket: string;
  expiresAt: string;
};

export class BrowserGatewayError extends Error {}

/** Status refreshes must not replace a live iframe for the same saved session. */
export function gatewaySessionIdentity(handoff: CdesktopHandoff): string {
  return JSON.stringify([
    handoff.id,
    handoff.receipt?.workspaceId || '',
    handoff.receipt?.sessionId || '',
  ]);
}

export function browserGatewayBootstrapUrl(origin: string, panelOrigin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new BrowserGatewayError('The cdesktop connection is not configured correctly.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin === panelOrigin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new BrowserGatewayError('The cdesktop connection is not configured correctly.');
  }
  return new URL('/_pyrito/session', url.origin).href;
}

export function validateBrowserGatewayGrant(
  value: unknown,
  origin: string,
  panelOrigin: string,
  now = Date.now(),
): BrowserGatewayGrant {
  const expectedUrl = browserGatewayBootstrapUrl(origin, panelOrigin);
  const grant = value as Partial<BrowserGatewayGrant> | null;
  if (
    !grant ||
    grant.bootstrapUrl !== expectedUrl ||
    typeof grant.ticket !== 'string' ||
    !grant.ticket ||
    grant.ticket.length > 8192 ||
    /\s/.test(grant.ticket) ||
    typeof grant.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(grant.expiresAt))
  ) {
    throw new BrowserGatewayError(
      'cdesktop could not open a secure session. Reconnect to try again.',
    );
  }
  if (Date.parse(grant.expiresAt) <= now) {
    throw new BrowserGatewayError(
      'The cdesktop connection expired before it opened. Reconnect to try again.',
    );
  }
  return grant as BrowserGatewayGrant;
}

/** Keep the single-use credential out of URLs, React state, storage and the retained DOM. */
export function postBrowserGatewayGrant(
  value: unknown,
  origin: string,
  panelOrigin: string,
  target: string,
  document: Document,
): void {
  const grant = validateBrowserGatewayGrant(value, origin, panelOrigin);
  const form = document.createElement('form');
  const input = document.createElement('input');
  form.method = 'POST';
  form.action = grant.bootstrapUrl;
  form.target = target;
  form.hidden = true;
  input.type = 'hidden';
  input.name = 'ticket';
  input.value = grant.ticket;
  form.append(input);
  document.body.append(form);
  try {
    form.submit();
  } finally {
    input.value = '';
    form.remove();
  }
}
