export type WorkbenchRuntime = 'orca' | 'cdesktop';

export function requestedRuntime(): WorkbenchRuntime {
  const query = window.location.hash.split('?')[1] || window.location.search;
  return new URLSearchParams(query).get('runtime') === 'cdesktop' ? 'cdesktop' : 'orca';
}

export function workbenchUrl(runtime: WorkbenchRuntime, taskId: string): string {
  const query = new URLSearchParams({ runtime });
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
  return (
    <div className="workbench-runtime-picker" role="group" aria-label="Workbench runtime">
      <button type="button" aria-pressed={runtime === 'orca'} onClick={() => onChange('orca')}>
        Orca
      </button>
      <button
        type="button"
        aria-pressed={runtime === 'cdesktop'}
        onClick={() => onChange('cdesktop')}
      >
        cdesktop <span>(trial)</span>
      </button>
    </div>
  );
}
