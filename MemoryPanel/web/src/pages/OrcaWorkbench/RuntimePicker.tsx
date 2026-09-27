export type WorkbenchRuntime = 'orca' | 'cdesktop';

// Presentation policy only: keep both runtime integrations and saved receipts intact.
export const DEFAULT_RUNTIME: WorkbenchRuntime = 'cdesktop';
export const VISIBLE_RUNTIMES: readonly WorkbenchRuntime[] = ['cdesktop'];

export function isRuntimeVisible(runtime: WorkbenchRuntime): boolean {
  return VISIBLE_RUNTIMES.includes(runtime);
}

function visibleRuntime(runtime: string | null): WorkbenchRuntime {
  return VISIBLE_RUNTIMES.find((candidate) => candidate === runtime) ?? DEFAULT_RUNTIME;
}

export function requestedRuntime(): WorkbenchRuntime {
  const query = window.location.hash.split('?')[1] || window.location.search;
  return visibleRuntime(new URLSearchParams(query).get('runtime'));
}

export function workbenchUrl(runtime: WorkbenchRuntime, taskId: string): string {
  const query = new URLSearchParams({ runtime: visibleRuntime(runtime) });
  if (taskId) query.set('task', taskId);
  return `/#/workbench?${query}`;
}

export function updateWorkbenchQuery(values: Record<string, string>) {
  const url = new URL(window.location.href);
  const hashRoute = url.hash.startsWith('#/');
  const [route, query = ''] = url.hash.split('?');
  const params = hashRoute ? new URLSearchParams(query) : url.searchParams;
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  if (hashRoute) url.hash = route + (params.size ? `?${params}` : '');
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event('workbench-query-change'));
}

export function RuntimePicker({
  runtime,
  onChange,
}: {
  runtime: WorkbenchRuntime;
  onChange: (runtime: WorkbenchRuntime) => void;
}) {
  if (VISIBLE_RUNTIMES.length < 2) return null;
  const labels: Record<WorkbenchRuntime, string> = { orca: 'Orca', cdesktop: 'cdesktop' };
  return (
    <div className="workbench-runtime-picker" role="group" aria-label="Workbench runtime">
      {VISIBLE_RUNTIMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={runtime === option}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}
