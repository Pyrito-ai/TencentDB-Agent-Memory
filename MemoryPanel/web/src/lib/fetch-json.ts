import i18n from '@/i18n';

/**
 * Reads a failed fetch response without assuming a JSON body: proxies and crashed upstreams
 * return HTML or nothing, which would otherwise surface as a JSON syntax error.
 */
export async function readResponseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '');
  let error: unknown;
  try {
    error = (JSON.parse(text) as { error?: unknown } | null)?.error;
  } catch {
    error = undefined;
  }
  if (typeof error === 'string' && error.trim()) return error;
  if (response.status === 401) return i18n.t('error.UNAUTHORIZED');
  if (response.status === 403) return i18n.t('error.PERMISSION_DENIED');
  if (response.status === 404) return i18n.t('error.NOT_FOUND');
  if (response.status >= 500) return i18n.t('error.INTERNAL_ERROR');
  return `${fallback} (HTTP ${response.status})`;
}

/** Parses a JSON response, throwing a readable error for failures and non-JSON bodies. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonResponse<T = any>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(await readResponseError(response, fallback));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(fallback);
  }
}
