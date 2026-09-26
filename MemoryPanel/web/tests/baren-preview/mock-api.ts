import { createData, TEAM, USER, LOOP_TIMEZONE, now, today } from './data';
import { writeTaskBoard, type BoardStatus } from '../../src/services/task-board';
import { periodFor } from '../../../src/panel/http/routes/loop-periods';
import {
  scheduleSummary,
  scheduledDays,
  validDate,
} from '../../../src/panel/http/routes/loop-schedule';

type Body = Record<string, any>;
type Call = { method: string; path: string; body: Body; status?: number; mutation?: boolean };
type Pending = { id: string; name: string; args: Body; status: string };
export function installMockApi() {
  const params = new URLSearchParams(location.search);
  const scenario = ['empty', 'loading', 'error'].includes(params.get('scenario') || '')
    ? params.get('scenario')!
    : 'populated';
  const role = ['member', 'reviewer'].includes(params.get('role') || '')
    ? params.get('role')!
    : 'admin';
  const data = createData(role, scenario === 'empty');
  const findTask = (id: string) =>
    data.tasks.find((task) => task.task_id === id) ||
    data.loopTasks.find((task) => task.task_id === id);
  const calls: Call[] = [];
  const blocked: Call[] = [];
  const revisions: Record<string, number> = {};
  let conflictUsed = false;
  const state: {
    revision: number;
    ready: boolean;
    messages: { role: string; text: string }[];
    pending?: Pending;
  } = {
    revision: 1,
    ready: params.get('coordinator') !== 'offline',
    messages:
      scenario === 'empty'
        ? []
        : [
            {
              role: 'assistant',
              text: 'Good morning, Alex. Your current work is here when you need it.\n\nI can help you explore the context, clarify a next step, or prepare a change for your review.',
            },
          ],
  };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const envelope = (value: unknown) => ({
    code: 0,
    message: 'Synthetic preview',
    request_id: 'preview',
    data: value,
  });
  const meta = (value: unknown) => json(envelope(value));
  const list = (items: unknown[], body: Body = {}) => {
    const offset = body.pagination?.offset ?? body.offset ?? 0;
    const limit = body.pagination?.limit ?? body.limit ?? 100;
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  };
  const failure = (message: string, status = 501) =>
    json({ error: message, message, code: status, request_id: 'preview', data: null }, status);
  const mark = (call: Call) => {
    call.mutation = true;
  };
  const api = async (path: string, body: Body, call: Call): Promise<Response | undefined> => {
    const action = path.split('/').pop();
    if (path === '/api/v1/meta/auth/verify') return meta({ valid: true, user: data.user });
    if (path === '/api/v1/meta/instances')
      return json({
        instances: [
          {
            instance_id: 'baren-preview',
            name: 'Isolated preview',
            gateway_endpoint: 'https://example.invalid/preview',
          },
        ],
        capabilities: { analyticsEnabled: params.get('analytics') !== 'off' },
      });
    if (path === '/api/v1/auth/methods')
      return json({
        methods: [{ id: 'user_key', type: 'user_key', display_name: 'API key', enabled: true }],
      });
    if (path === '/api/v1/auth/session') return json({ authenticated: false });
    if (path === '/api/v1/meta/team/list') return meta(list([data.team], body));
    if (path === '/api/v1/meta/team/get') return meta(data.team);
    if (path === '/api/v1/meta/team-member/list') return meta(list(data.members, body));
    if (path === '/api/v1/meta/user/get')
      return meta(data.users.find((user) => user.user_id === body.user_id) || data.user);
    if (path === '/api/v1/meta/user/list')
      return meta(
        list(
          body.user_ids
            ? data.users.filter((user) => body.user_ids.includes(user.user_id))
            : data.users,
          body,
        ),
      );
    if (path === '/api/v1/analytics/config')
      return meta({
        configured: true,
        reachable: true,
        database: 'synthetic',
        tables: { session_init_events: true, bridge_call_events: true },
      });

    // Auth, membership and capability discovery remain available to render the real shell.
    // Resource calls exercise the page's normal loading/error states.
    if (scenario === 'loading') return new Promise<Response>(() => {});
    if (scenario === 'error')
      return failure('Synthetic preview error. Reload with scenario=populated to recover.', 503);

    if (path === '/api/v1/meta/agent/list' || path === '/api/v1/meta/agent/list-accessible')
      return meta(list(data.agents, body));
    if (path === '/api/v1/meta/agent/get')
      return meta(
        data.agents.find((agent) => agent.agent_id === body.agent_id) || data.agents[0] || {},
      );
    if (path === '/api/v1/meta/task/list' || path === '/api/v1/task/list-with-agents')
      return meta(list(data.tasks, body));
    if (path === '/api/v1/meta/participation-log/list') return meta(list([], body));
    if (path === '/api/v1/meta/task-agent/list')
      return meta(list(findTask(body.task_id)?.agents || [], body));
    if (path === '/api/v1/meta/task/get') return meta(findTask(body.task_id) || {});
    if (path === '/api/v1/meta/task/board-state')
      return meta({
        task: findTask(body.task_id),
        revision: String(revisions[body.task_id] || 1),
      });
    if (path === '/api/v1/meta/task/board-transition') {
      mark(call);
      const task = findTask(body.task_id);
      if (!task) return failure('Preview task not found.', 404);
      const revision = revisions[task.task_id] || 1;
      if (body.expected_revision !== String(revision))
        return failure('Preview task changed. Please reload.', 409);
      task.metadata_json = writeTaskBoard(task.metadata_json, {
        status: body.status as BoardStatus,
      });
      task.status = body.status === 'done' ? 'completed' : 'running';
      revisions[task.task_id] = revision + 1;
      return meta({ task, revision: String(revision + 1) });
    }
    if (path === '/api/v1/meta/task/create') {
      mark(call);
      const task = {
        task_id: crypto.randomUUID(),
        team_id: TEAM,
        creator_user_id: USER,
        title: body.title || 'Untitled task',
        description: body.description || '',
        source_type: body.source_type || 'manual',
        source_url: '',
        risk_level: 'low',
        status: 'running',
        auto_assign_floating_assets: 0,
        agents: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata_json: body.metadata_json || writeTaskBoard('{}', { status: 'backlog' }),
      };
      data.tasks.push(task);
      return meta(task);
    }
    if (path === '/api/v1/meta/task/update') {
      mark(call);
      const task = findTask(body.task_id);
      if (!task) return failure('Preview task not found.', 404);
      const revision = revisions[task.task_id] || 1;
      if (body.expected_revision && body.expected_revision !== String(revision))
        return failure('Preview task changed. Please reload.', 409);
      for (const key of ['title', 'description', 'status', 'metadata_json', 'source_url'] as const)
        if (body[key] !== undefined) task[key] = body[key];
      revisions[task.task_id] = revision + 1;
      return meta(task);
    }
    if (path === '/api/v1/meta/task/delete') {
      mark(call);
      data.tasks = data.tasks.filter((task) => !body.task_ids?.includes(task.task_id));
      data.loopTasks = data.loopTasks.filter((task) => !body.task_ids?.includes(task.task_id));
      return meta({ deleted_ids: body.task_ids });
    }
    if (path === '/api/v1/meta/user-key/list')
      return meta(
        list(
          scenario === 'empty'
            ? []
            : [
                {
                  key_id: 'preview-key-label',
                  name: 'Local development',
                  key_prefix: 'fixture-****',
                  created_at: new Date(now - 86400000).toISOString(),
                  last_used_at: new Date(now).toISOString(),
                },
              ],
          body,
        ),
      );
    if (path === '/api/v1/meta/config/user/view' || path === '/api/v1/meta/config/user/get')
      return meta({ items: [], revision: 'preview' });
    if (path === '/api/v1/meta/config/user/list') return meta(list([], body));
    if (
      path === '/api/v1/meta/agent-template/get-default-template' ||
      path === '/api/v1/meta/agent/get-default-template'
    )
      return meta({
        prompt: '',
        metadata_json: '{}',
        skills: [],
        code_graphs: [],
        llm_wikis: [],
        chat_memories: [],
      });

    if (path.startsWith(`/api/v1/projects/${TEAM}/`)) {
      if (action === 'list')
        return json({
          items: data.projects,
          assignments: data.assignments,
          canAssignAny: role === 'admin',
        });
      if (action === 'assign') {
        mark(call);
        data.assignments = data.assignments.filter((item) => item.task !== body.task);
        if (body.projectId) data.assignments.push({ task: body.task, project_id: body.projectId });
        return json({ ok: true });
      }
      if (['create', 'update', 'archive'].includes(action || '')) {
        mark(call);
        if (role !== 'admin') return failure('Preview role cannot manage projects.', 403);
        const project = data.projects.find((item) => item.id === body.id);
        let createdId = '';
        if (action === 'create')
          data.projects.push({
            id: (createdId = crypto.randomUUID()),
            name: body.name,
            description: body.description || '',
            archived: 0,
            canManage: true,
          });
        if (project && action === 'update')
          Object.assign(project, { name: body.name, description: body.description });
        if (project && action === 'archive') project.archived = body.archived ? 1 : 0;
        return json({ ok: true, id: createdId || project?.id });
      }
    }
    if (path === `/api/v1/areas/${TEAM}/list`) return json({ items: data.areas });
    if (path === `/api/v1/loops/${TEAM}/list`) {
      if (call.method !== 'GET') return failure('Method not allowed', 405);
      if (body.through && !validDate(body.through))
        return failure('Invalid calendar end date', 400);
      data.loops = data.loops.map((loop) => ({
        ...loop,
        ...scheduleSummary(
          loop,
          data.history.filter((item) => item.loop_id === loop.id),
          now,
          body.through,
        ),
      }));
      return json({
        items: data.loops,
        history: data.history,
        timezone: LOOP_TIMEZONE,
        canManageTimezone: role === 'admin',
      });
    }
    if (path === `/api/v1/loops/${TEAM}/start`) {
      if (call.method !== 'POST') return failure('Method not allowed', 405);
      const loop = data.loops.find((item) => item.id === body.loopId && !item.archived);
      if (!loop) return failure('Choose an active loop.', 404);
      if (
        typeof body.requestId !== 'string' ||
        !/^[-a-zA-Z0-9]{16,80}$/.test(body.requestId) ||
        typeof body.agentId !== 'string'
      )
        return failure('Invalid occurrence request', 400);
      // The isolated preview supports human work only; never create agent/runtime work.
      if (body.agentId)
        return failure('Synthetic preview does not support agent handoffs. No agent was started.');
      const area = data.areas.find((item) => item.id === loop.area_id && !item.archived);
      if (!area) return failure('Restore or change this Loop’s Area before starting work.', 409);
      const project = loop.project_id
        ? data.projects.find((item) => item.id === loop.project_id && !item.archived)
        : { name: '' };
      if (!project)
        return failure('Restore or unlink the archived project before starting work.', 409);
      const dueDay = loop.mode === 'scheduled' ? body.dueDay : '';
      if (
        loop.mode === 'scheduled' &&
        (!validDate(dueDay) || !scheduledDays(loop, dueDay).includes(dueDay))
      )
        return failure('Choose a valid deadline on this Loop’s schedule.', 400);
      const slot =
        loop.mode === 'scheduled'
          ? data.history.find((item) => item.loop_id === loop.id && item.due_day === dueDay)
          : undefined;
      if (slot && slot.id !== body.requestId)
        return json(
          {
            error: 'This deadline already has an occurrence. Open it from the history.',
            occurrenceId: slot.id,
          },
          409,
        );
      const existing = data.history.find((item) => item.id === body.requestId);
      if (
        existing &&
        (existing.author !== USER || existing.loop_id !== loop.id || existing.due_day !== dueDay)
      )
        return failure('Request ID already used.', 409);
      if (existing?.task_id) return json({ occurrence: existing });
      if (existing)
        return failure(
          'The prior task preparation is incomplete. Check the occurrence before retrying.',
          409,
        );

      const startedAt = Date.now();
      const period = dueDay
        ? periodFor(Date.parse(`${dueDay}T12:00:00Z`), 'UTC', loop.frequency)
        : periodFor(startedAt, loop.timezone, loop.frequency);
      const taskId = crypto.randomUUID();
      const occurrence = {
        id: body.requestId,
        loop_id: loop.id,
        author: USER,
        task_id: taskId,
        agent_id: '',
        project_id: loop.project_id,
        project_name: project.name,
        area_id: loop.area_id,
        area_name: area.name,
        owner_id: loop.owner_id,
        due_day: dueDay,
        brief: loop.brief,
        period,
        state: 'open',
        created_at: startedAt,
        completed_at: null,
        note: '',
        result_url: '',
        time: [],
      };
      mark(call);
      data.tasks.push({
        task_id: taskId,
        team_id: TEAM,
        creator_user_id: USER,
        title: `${loop.name} · ${period}`,
        description: loop.brief,
        source_type: 'manual',
        source_url: '',
        risk_level: 'low',
        status: 'running',
        auto_assign_floating_assets: 0,
        agents: [],
        created_at: new Date(startedAt).toISOString(),
        updated_at: new Date(startedAt).toISOString(),
        metadata_json: writeTaskBoard(
          JSON.stringify({
            loop_id: loop.id,
            loop_occurrence: occurrence.id,
            area_id: loop.area_id,
          }),
          { status: 'in_progress', assignee: loop.owner_id, dueDate: dueDay },
        ),
      });
      if (loop.project_id) data.assignments.push({ task: taskId, project_id: loop.project_id });
      data.history.unshift(occurrence);
      return json({ occurrence }, 201);
    }
    if (path.startsWith(`/api/v1/timesheets/${TEAM}/`)) {
      const entries = data.time.filter(
        (item) =>
          (!body.author || item.author === body.author) &&
          (role !== 'member' || item.author === USER),
      );
      const sum = (status?: string) =>
        entries
          .filter((item) => !status || item.review_state === status)
          .reduce((total, item) => total + item.seconds, 0);
      if (action === 'list')
        return json({
          items: entries,
          contributors: [USER, 'baren-preview-jamie'],
          totals: {
            completed: sum(),
            pending: sum('pending'),
            payable: sum('approved'),
            paid: sum('paid'),
            running: 0,
          },
          daily: entries.length ? { [today]: sum() } : {},
          canReview: role !== 'member',
          canPay: role === 'admin',
          unresolvedLegacy: 0,
        });
      if (action === 'csv')
        return new Response(
          'Task,Seconds\n' + entries.map((item) => `${item.title},${item.seconds}`).join('\n'),
          { headers: { 'Content-Type': 'text/csv' } },
        );
      if (action === 'approve' || action === 'reopen') {
        mark(call);
        if (role === 'member') return failure('Preview role cannot review time.', 403);
        for (const item of data.time)
          if (body.ids.includes(item.id) && item.review_state !== 'paid')
            item.review_state = action === 'approve' ? 'approved' : 'pending';
        return json({ ok: true });
      }
    }
    if (/^\/api\/v1\/task\/time\/[^/]+\/list$/.test(path))
      return json({
        items: data.time.filter((item) => item.task === path.split('/')[5]),
        otherRunning: false,
        serverNow: Date.now(),
      });
    if (/^\/api\/v1\/task\/activity\/[^/]+\/list$/.test(path))
      return json({
        items:
          scenario === 'empty'
            ? []
            : [
                {
                  id: 'preview-note',
                  kind: 'note',
                  author: USER,
                  createdAt: new Date(now - 3600000).toISOString(),
                  text: 'Keep the outcome clear and share the next step for review. Synthetic preview note.',
                },
              ],
      });

    if (path.startsWith(`/api/v1/coordinator/${TEAM}/`)) {
      if (params.get('coordinator') === 'error')
        return failure('Synthetic coordinator unavailable. Drafts are preserved.', 503);
      if (action === 'state') return json(state);
      if (!['message', 'approve', 'cancel'].includes(action || '')) return undefined;
      mark(call);
      if (body.revision !== state.revision)
        return failure('The preview conversation changed. Refresh before applying.', 409);
      if (action === 'message') {
        state.messages.push({ role: 'user', text: body.text });
        if (/creat|propos|add.*task/i.test(body.text)) {
          state.pending = {
            id: crypto.randomUUID(),
            name: 'meta/task/create',
            args: {
              title: 'Clarify the next product milestone',
              description: 'Agree the outcome and acceptance criteria. Synthetic preview task.',
            },
            status: 'proposed',
          };
          state.messages.push({
            role: 'assistant',
            text: 'I’ve prepared a task for your review. You can inspect the details below, then apply or dismiss it.',
          });
        } else {
          state.messages.push({
            role: 'assistant',
            text: `There are ${data.tasks.filter((task) => task.status !== 'completed').length} open tasks in this synthetic workspace. Start with an overdue item, then review the work awaiting your decision.\n\nYou can also ask me to create a task; I’ll show the proposed change for review.`,
          });
        }
      }
      if (action === 'approve' && params.get('coordinator') === 'conflict' && !conflictUsed) {
        conflictUsed = true;
        state.revision++;
        return failure('The preview conversation changed. Refresh before applying.', 409);
      }
      if (action === 'approve' || action === 'cancel') {
        if (!state.pending || state.pending.id !== body.id || state.pending.status !== 'proposed')
          return failure('This preview proposal is no longer available.', 409);
        if (action === 'approve') {
          const nested: Call = {
            method: 'POST',
            path: '/api/v1/meta/task/create',
            body: state.pending.args,
          };
          await api(nested.path, nested.body, nested);
          state.pending.status = 'done';
          state.messages.push({
            role: 'assistant',
            text: 'The task was created in this preview. No live data was changed.',
          });
        } else {
          state.pending.status = 'cancelled';
          state.messages.push({
            role: 'assistant',
            text: 'Proposal dismissed. No task was created.',
          });
        }
      }
      state.revision++;
      return json({ ...state, changed: action === 'approve' });
    }
    if (path.startsWith(`/api/v1/workbench/${TEAM}/`)) {
      if (action === 'options')
        return json({ bindings: [], projectRuntimes: [], coordinatorReady: false });
      if (action === 'cdesktop-options') return json({ bindings: [], ready: false });
      if (action === 'runs' || action === 'handoff-profiles') return json({ items: [] });
      if (action === 'handoff-get' || action === 'cdesktop-handoff-get')
        return json({ handoff: null });
      if (action === 'context-get')
        return json({
          references: [],
          inherited: [],
          canEdit: role === 'admin',
          revision: 1,
          warnings: [],
          text: '',
          preview: '',
          entries: [],
        });
      if (action === 'context-catalog') return json({ items: [], wikis: data.knowledge });
      if (action === 'context-preview')
        return json({
          text: 'Synthetic context only.',
          excerpts: [],
          warnings: [],
          entries: [],
          references: [],
        });
      if (action === 'context-pages') return json({ items: [] });
      if (action === 'execution-get')
        return json({
          taskId: body.taskId,
          canApprove: false,
          canBind: false,
          canAccept: false,
          backgroundReady: false,
          eligibility: {
            eligible: false,
            reasons: ['Worker launches are disabled in this isolated preview.'],
          },
        });
    }
    if (path.startsWith('/api/v1/knowledge/')) {
      if (path.endsWith('/wiki/team-assets') || path.endsWith('/wiki/list'))
        return meta(list(data.knowledge, body));
      if (path.endsWith('/code-graph/team-assets') || path.endsWith('/code-graph/list'))
        return meta(list(data.code, body));
      if (path.endsWith('/wiki/get')) return meta(data.knowledge[0] || {});
      if (path.endsWith('/code-graph/get')) return meta(data.code[0] || {});
      if (path.endsWith('/agent-fixed')) return meta(list([], body));
      if (path.endsWith('/wiki/page/ls'))
        return meta({
          items: ['Design principles', 'Customer observations', 'Decisions'].map(
            (title, index) => ({
              path: `notes/page-${index + 1}.md`,
              title,
              type: 'page',
              tags: ['product'],
              created: new Date(now).toISOString(),
              updated: new Date(now).toISOString(),
            }),
          ),
        });
      if (path.endsWith('/wiki/page/read'))
        return meta({
          items: (body.refs || []).map((ref: string) => ({
            ref,
            content:
              '# A shared understanding\n\nMake the next step clear. Keep decisions close to the work, and give people enough context to act.\n\n## Principles\n\n- Start with a meaningful outcome.\n- Keep a record of the decision.\n- Review proposed changes.\n\nThis is synthetic preview content.',
          })),
        });
      if (path.endsWith('/wiki/raw/ls'))
        return meta({ items: [{ filename: 'field-notes.md', size: 310 }] });
      if (path.endsWith('/wiki/raw/read'))
        return meta({
          items: [
            { filename: 'field-notes.md', content: '# Field notes\nSynthetic preview source.' },
          ],
        });
      if (path.endsWith('/wiki/search'))
        return meta({
          results: [
            {
              path: 'notes/page-1.md',
              title: 'Design principles',
              snippet: 'Make the next step clear.',
              score: 0.91,
              type: 'page',
            },
          ],
        });
      if (path.endsWith('/wiki/graph'))
        return meta({
          nodes: [
            {
              id: 'notes/page-1.md',
              label: 'Design principles',
              type: 'page',
              path: 'notes/page-1.md',
              linkCount: 1,
              community: 0,
            },
            {
              id: 'notes/page-2.md',
              label: 'Customer observations',
              type: 'page',
              path: 'notes/page-2.md',
              linkCount: 1,
              community: 0,
            },
          ],
          edges: [{ source: 'notes/page-1.md', target: 'notes/page-2.md', weight: 1 }],
        });
      if (path.endsWith('/code-graph/search')) return meta({ results: [] });
      if (path.endsWith('/code-graph/explore')) return meta({ nodes: [], edges: [], files: [] });
      if (path.endsWith('/health')) return meta({ ok: true });
    }
    if (path.startsWith('/api/v1/skill/')) {
      if (action === 'list' || action === 'search') return meta(list(data.skills, body));
      if (action === 'get') return meta(data.skills[0] || {});
      if (action === 'versions') return meta({ items: data.skills, versions: data.skills });
      if (action === 'listing')
        return meta({
          items: data.skills[0]?.manifest || [],
          entries: data.skills[0]?.manifest || [],
        });
      if (path.endsWith('/files/read'))
        return meta({
          files: [
            {
              path: 'SKILL.md',
              content: data.skills[0]?.content || '',
              encoding: 'utf-8',
              size_bytes: 249,
              mime_type: 'text/markdown',
            },
          ],
        });
    }
    if (path.startsWith('/api/v1/chat-memory/')) {
      if (['team-assets', 'my-agents', 'agent-fixed', 'mine'].includes(action || ''))
        return meta(list(data.memory, body));
      if (action === 'layer' || action === 'search')
        return meta({
          ...list(
            scenario === 'empty'
              ? []
              : [
                  {
                    id: 'preview-memory-note',
                    title: 'Decisions need context',
                    role: 'assistant',
                    body: 'Record the reason behind a decision alongside the next step. Synthetic preview content.',
                    tags: ['product'],
                    created_at: new Date(now).toISOString(),
                  },
                ],
            body,
          ),
          layer: body.layer || 'L1',
        });
    }
    if (path.startsWith('/api/v1/analytics/')) {
      if (path.endsWith('/session-init/summary'))
        return meta({
          tool_call_rate: { current_pct: 75, previous_pct: 68, delta_pp: 7 },
          avg_calls: { current_avg: 3.4, previous_avg: 3, delta: 0.4 },
          bypass_rate: {
            current_pct: 8,
            previous_pct: 12,
            delta_pp: -4,
            bypass_sessions: 8,
            non_bypass_sessions: 92,
          },
          distinct_init_sessions: scenario === 'empty' ? 0 : 100,
          total_bridge_calls: scenario === 'empty' ? 0 : 340,
        });
      if (path.endsWith('/session-init/timeseries'))
        return meta({
          series:
            scenario === 'empty'
              ? []
              : [{ day: today, init_sessions: 100, called_sessions: 75, bypass_sessions: 8 }],
        });
      if (path.endsWith('/tool-calls/endpoint-share'))
        return meta({
          endpoints:
            scenario === 'empty'
              ? []
              : [
                  { executed_endpoint: 'memory/search', calls: 240, pct: 70.6 },
                  { executed_endpoint: 'knowledge/search', calls: 100, pct: 29.4 },
                ],
        });
      if (path.endsWith('/tool-calls/top-bodies')) return meta({ items: [] });
      if (path.endsWith('/session-init/bypass-reasons')) return meta({ reasons: [] });
      if (path.endsWith('/tool-calls/list'))
        return meta(
          list(
            scenario === 'empty'
              ? []
              : [
                  {
                    timestamp: new Date(now).toISOString(),
                    session_key: 'preview-session',
                    turn_seq: 1,
                    user_id: USER,
                    agent_source: 'Research companion',
                    kind: 'bridge_call',
                    bridge_source: 'fixture',
                    initiated_tool: 'memory_search',
                    executed_endpoint: 'memory/search',
                    request_body: '{"query":"design principles"}',
                    request_body_hash: 'synthetic-hash',
                    upstream_status: 200,
                    elapsed_ms: 84,
                    reject_reason: '',
                  },
                ],
            body,
          ),
        );
      if (path.endsWith('/usage/summary'))
        return meta({
          total_requests: scenario === 'empty' ? 0 : 100,
          total_prompt_tokens: scenario === 'empty' ? 0 : 25000,
          total_completion_tokens: scenario === 'empty' ? 0 : 7000,
          total_tokens: scenario === 'empty' ? 0 : 32000,
          total_credit: 0,
          cache_hit_rate: 0,
        });
      if (path.endsWith('/usage/timeseries'))
        return meta({
          series:
            scenario === 'empty'
              ? []
              : [
                  {
                    day: today,
                    requests: 100,
                    prompt_tokens: 25000,
                    completion_tokens: 7000,
                    cache_hit_tokens: 5000,
                    credit: 0,
                    credit_saved: 0,
                  },
                ],
        });
      if (path.endsWith('/usage/models') || path.endsWith('/usage/by-model'))
        return meta({
          models:
            scenario === 'empty'
              ? []
              : [
                  {
                    model_id: 'fixture-model',
                    model_name: 'Synthetic preview model',
                    requests: 100,
                    total_tokens: 32000,
                    credit: 0,
                    pct_requests: 100,
                    pct_credit: null,
                    routed_to_count: 0,
                  },
                ],
        });
      if (
        path.endsWith('/usage/list') ||
        path.endsWith('/usage/raw-list') ||
        path.endsWith('/usage-raw/list')
      )
        return meta(list([], body));
    }
    return undefined;
  };

  // Do not retain or call the original fetch: every app request is handled here
  // or explicitly refused. Dynamic ESM/assets use the browser module loader.
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    let body: Body = {};
    try {
      body = JSON.parse(
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request
            ? (await input.clone().text()) || '{}'
            : '{}',
      );
    } catch {
      /* Unknown multipart/binary writes are refused below. */
    }
    for (const [key, value] of url.searchParams) if (!(key in body)) body[key] = value;
    const call: Call = { method, path: url.pathname, body };
    calls.push(call);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) {
      blocked.push(call);
      return failure(`Preview blocked network request: ${method} ${url.pathname}`);
    }
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await api(url.pathname, body, call);
    if (result) {
      call.status = result.status;
      return result;
    }
    call.status = 501;
    blocked.push(call);
    return failure(
      `Synthetic preview does not implement ${method} ${url.pathname}. No request was sent.`,
    );
  };
  XMLHttpRequest.prototype.open = function () {
    throw new Error('XHR network calls are disabled in the isolated preview.');
  };
  navigator.sendBeacon = () => false;
  Object.assign(window, {
    __barenPreview: { scenario, role, data, coordinator: state, calls, blocked, synthetic: true },
  });
  localStorage.setItem('tdai-memory.lang', 'en-US');
  localStorage.setItem('tdai-memory.activeTeam.v1', TEAM);
  localStorage.setItem(
    `tdai-panel.onboarded.${USER}`,
    params.get('onboarding') === '1' ? '0' : '1',
  );
  if (params.get('auth') === 'login') localStorage.removeItem('tdai-panel.session');
  else
    localStorage.setItem(
      'tdai-panel.session',
      JSON.stringify({
        instanceId: 'baren-preview',
        instanceName: 'Isolated preview',
        userKey: 'synthetic-preview-not-a-secret',
        user: data.user,
      }),
    );
  if (!location.hash)
    history.replaceState(null, '', `${location.pathname}${location.search}#/today`);
  return { scenario, role };
}
