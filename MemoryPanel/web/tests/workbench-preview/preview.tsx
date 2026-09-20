// Synthetic browser fixture. This page never launches Orca or calls a model.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from '../../src/pages/OrcaWorkbench';
import { setPanelSession } from '../../src/lib/panelSession';
import '../../src/i18n';
setPanelSession({ instanceId: 'preview', userKey: 'preview-only' });
let run: any;
window.fetch = async (input, init) => {
  const action = String(input).split('/').pop();
  const b = JSON.parse(String(init?.body || '{}'));
  if (action === 'options')
    return Response.json({
      bindings: [{ id: 'demo', label: 'John’s Orca · Tencent repo' }],
      coordinatorReady: true,
    });
  if (action === 'runs') return Response.json({ items: [] });
  if (action === 'plan')
    run = {
      id: 'demo-run',
      objective: b.objective,
      summary: 'One bounded worker will implement and verify this change in a separate worktree.',
      created: Date.now(),
      workers: [
        {
          id: 'demo-worker',
          title: 'Implement the change',
          agent: 'codex',
          spec: 'Own the relevant feature files. Add meaningful checks and report evidence. Do not merge or deploy.',
          state: 'proposed',
        },
      ],
    };
  if (action === 'dispatch')
    run.workers[0] = {
      ...run.workers[0],
      state: 'running',
      receipt: { worktree: 'tencent-demo', notice: 'Synthetic worker for UI verification.' },
    };
  if (action === 'refresh')
    run.workers[0].receipt = {
      ...run.workers[0].receipt,
      output: 'Synthetic result: feature implemented; 8 checks passed. Diff awaits human review.',
    };
  if (action === 'review')
    run.review =
      'The worker reports passing checks. Inspect the diff and verify acceptance criteria before merging.';
  return Response.json(run);
};
createRoot(document.getElementById('root')!).render(
  <>
    <p style={{ padding: '12px 24px', background: '#fff3d6' }}>
      Local UI fixture · synthetic data · no worker execution or model charges
    </p>
    <Workspace team="preview" />
  </>,
);
