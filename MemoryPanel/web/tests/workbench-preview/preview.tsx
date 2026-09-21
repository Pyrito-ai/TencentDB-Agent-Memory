// Synthetic browser fixture. No production calls, model charges or real worker launches.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from '../../src/pages/OrcaWorkbench';
import { setPanelSession } from '../../src/lib/panelSession';
import '../../src/i18n';
setPanelSession({ instanceId: 'preview', userKey: 'preview-only' });
const now = Date.now();
const context =
  'Repository: Tencent Agent Memory\nKeep worker credentials on the Orca host. Each worker gets a separate worktree. Preserve existing team permissions.';
const workers = [
  {
    id: 'worker-api',
    title: 'Build the worker connection',
    agent: 'codex',
    spec: 'Own the runtime bridge and dispatch API. Validate user and team scopes, persist launch receipts, and prove retries cannot create duplicate workers.',
    state: 'running',
    receipt: {
      worktree: 'tencent/worker-connection',
      output:
        'Codex · Workbench worker\n\n› Build the worker connection\n\nReading the runner contracts and existing authorization checks.\n\n  ✓ Inspected terminal and worktree interfaces\n  ✓ Added scoped follow-up delivery\n  ✓ Added a persistent dispatch receipt\n\nRunning bridge integration checks…\n\n  PASS  rejects unapproved repositories\n  PASS  preserves receipts across restarts\n  PASS  handles uncertain launch outcomes\n\nNext: inspect the diff and report the validation evidence.',
      notice: 'Synthetic worker output for the local preview.',
    },
  },
  {
    id: 'worker-ui',
    title: 'Design the workspace surface',
    agent: 'claude',
    spec: 'Own the Workbench UI. Keep the coordinator conversation visible beside worker sessions, files, changes, and review. Verify keyboard navigation and responsive layouts.',
    state: 'proposed',
  },
  {
    id: 'worker-tests',
    title: 'Verify access boundaries',
    agent: 'codex',
    spec: 'Review team and user authorization, path traversal, duplicate launch protection, and review snapshot validation. Report findings without changing unrelated files.',
    state: 'exited',
    receipt: {
      worktree: 'tencent/access-review',
      output:
        'Synthetic review complete. Access boundary tests pass; live integration remains unverified.',
      notice: 'Terminal exited. This is not a task completion verdict.',
    },
  },
];
let runs: any[] = [
  {
    id: 'demo-run',
    binding: 'demo',
    objective: 'Build a shared workspace for subscription workers',
    context,
    summary: 'A shared workspace around the coordinator conversation.',
    created: now - 600000,
    workers,
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'I want to keep the coordinator conversation open while Codex and Claude work. Let me see their sessions and review changes in the same workspace.',
        created: now - 540000,
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'We can organize this as three bounded pieces of work.\n\nCodex will handle the worker connection and durable receipts. Claude Code can build the workspace surface. A separate Codex worker will verify the access boundaries.\n\nEach works in its own worktree. I’ll keep decisions and results together here, and you can inspect any worker alongside this conversation.',
        created: now - 520000,
      },
      {
        id: 'm3',
        role: 'event',
        text: 'Worker connection dispatched to Codex · separate worktree created.',
        created: now - 480000,
      },
      {
        id: 'm4',
        role: 'user',
        text: 'Keep the interface quiet. I need to follow the work without constantly switching views.',
        created: now - 240000,
      },
      {
        id: 'm5',
        role: 'assistant',
        text: 'Agreed. The coordinator stays in the band above Orca. The workspace below uses Orca’s actual interface, including its sessions, files, diffs, and worktree controls.\n\nThe connection worker is running now. You can approve the UI worker below when you’re ready.',
        created: now - 210000,
      },
    ],
  },
];
const snapshot = {
  branch: 'workbench/worker-connection',
  base: '4f7a03a9',
  snapshot: 'preview-snapshot',
  truncated: false,
  files: [
    { path: 'src/workbench/runner.ts', status: 'M' },
    { path: 'src/workbench/types.ts', status: 'A' },
    { path: 'tests/runner.test.ts', status: 'M' },
    { path: 'README.md', status: ' ' },
  ],
  diff: 'diff --git a/src/workbench/runner.ts b/src/workbench/runner.ts\n--- a/src/workbench/runner.ts\n+++ b/src/workbench/runner.ts\n@@ -12,4 +12,9 @@ export async function launchWorker(task) {\n-  return runtime.launch(task);\n+  const receipt = await store.find(task.id);\n+  if (receipt) return receipt;\n+\n+  await store.claim(task.id);\n+  const worker = await runtime.launch(task);\n+  return store.save(task.id, worker);\n }',
};
window.fetch = async (input, init) => {
  const action = String(input).split('/').pop();
  const b = JSON.parse(String(init?.body || '{}'));
  if (action === 'options')
    return Response.json({
      bindings: [
        {
          id: 'demo',
          label: 'Tencent Agent Memory',
          webUrl: 'http://127.0.0.1:5188/web-index.html',
        },
      ],
      coordinatorReady: true,
    });
  if (action === 'runs') return Response.json({ items: runs });
  if (action === 'start') {
    const run = {
      id: crypto.randomUUID(),
      binding: 'demo',
      objective: b.objective,
      context: b.context || '',
      summary: 'Let’s work through it.',
      created: Date.now(),
      workers: [],
      messages: [
        { id: crypto.randomUUID(), role: 'user', text: b.objective, created: Date.now() },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: 'Let’s clarify the outcome and acceptance criteria before dispatching workers. What should a successful result look like?',
          created: Date.now(),
        },
      ],
    };
    runs = [run, ...runs];
    return Response.json(run);
  }
  const run = runs.find((r) => r.id === b.id) || runs[0];
  const worker = run.workers.find((w: any) => w.id === b.workerId) || run.workers[0];
  if (action === 'message')
    run.messages.push(
      { id: crypto.randomUUID(), role: 'user', text: b.text, created: Date.now() },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: 'I’ll keep that constraint in this conversation. We can inspect the worker’s current changes in Orca below before deciding what to do next.',
        created: Date.now(),
      },
    );
  if (action === 'dispatch') {
    worker.state = 'running';
    worker.receipt = {
      worktree: 'tencent/' + worker.id,
      output: 'Synthetic worker started. Reading the assigned task…',
      notice: 'Synthetic launch for UI verification.',
    };
    run.messages.push({
      id: crypto.randomUUID(),
      role: 'event',
      text: worker.title + ' launched in a separate worktree.',
      created: Date.now(),
    });
  }
  if (action === 'workspace') return Response.json(snapshot);
  if (action === 'file')
    return Response.json({
      path: b.path,
      content:
        '// Synthetic preview file\nexport async function launchWorker(task) {\n  const receipt = await store.find(task.id);\n  if (receipt) return receipt;\n\n  await store.claim(task.id);\n  const worker = await runtime.launch(task);\n  return store.save(task.id, worker);\n}\n',
    });
  if (action === 'send') {
    worker.receipt.output += '\n\n› ' + b.text + '\n\nFollow-up received (synthetic).';
    worker.receipt.notice = 'Synthetic follow-up delivered.';
  }
  if (action === 'stop') {
    worker.state = 'exited';
    worker.receipt.notice = 'Synthetic worker stopped; files preserved.';
  }
  if (action === 'decision') {
    worker.review = {
      decision: b.decision,
      comment: b.text,
      snapshot: b.snapshot,
      created: Date.now(),
    };
    run.messages.push({
      id: crypto.randomUUID(),
      role: 'event',
      text:
        b.decision === 'approved'
          ? 'Changes approved for this snapshot. Nothing merged.'
          : 'Review recorded: ' + b.text,
      created: Date.now(),
    });
  }
  if (action === 'review') {
    run.review =
      'The launch receipt is persisted before the external call, and repeated job IDs return the existing worker. Tests shown cover access checks and restart recovery.\n\nRemaining: verify a real subscription-backed launch before deployment.';
    worker.assessment = run.review;
    run.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      text: run.review,
      created: Date.now(),
    });
  }
  return Response.json(run);
};
createRoot(document.getElementById('root')!).render(
  <>
    <div
      style={{
        padding: '8px 22px',
        background: '#faf3df',
        color: '#998559',
        font: '11px system-ui',
      }}
    >
      DEMO ONLY · This coordinator never sends tasks to Orca.{' '}
      <a href="/workbench/index.html">Open live Workbench</a>
    </div>
    <Workspace team="preview" />
  </>,
);
