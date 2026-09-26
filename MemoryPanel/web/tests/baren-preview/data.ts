// Entirely invented records. IDs and credentials are fixture labels, never real accounts.
import { writeTaskBoard, type BoardStatus } from '../../src/services/task-board';
import { addDays } from '../../src/services/task-schedule';
import type { Loop, Occurrence } from '../../src/pages/WorkbenchPage/components/loop-types';
import { localDay, periodFor } from '../../../src/panel/http/routes/loop-periods';
import { scheduleSummary } from '../../../src/panel/http/routes/loop-schedule';

export const TEAM = 'baren-preview-team';
export const USER = 'baren-preview-user';
export const AGENT = 'baren-preview-agent';
export const LOOP_TIMEZONE = 'Europe/Madrid';
export const now = Date.now();
export const today = localDay(now, LOOP_TIMEZONE);
const date = new Date(now).toISOString();
export function createData(role: string, empty: boolean) {
  const user = {
    user_id: USER,
    username: 'Alex',
    display_name: 'Alex Morgan',
    auth_provider: 'fixture',
    external_id: 'preview',
    user_type: role === 'admin' ? 'system_admin' : 'user',
    status: 'active',
    created_at: date,
    updated_at: date,
  };
  const others = [
    {
      ...user,
      user_id: 'baren-preview-jamie',
      username: 'Jamie',
      display_name: 'Jamie Chen',
      user_type: 'user',
    },
    {
      ...user,
      user_id: 'baren-preview-sam',
      username: 'Sam',
      display_name: 'Sam Rivera',
      user_type: 'user',
    },
  ];
  const team = {
    team_id: TEAM,
    name: 'Design studio',
    description: 'A shared space for thoughtful work.',
    owner_user_id: role === 'admin' ? USER : others[0].user_id,
    status: 'active',
    created_at: date,
    updated_at: date,
    metadata_json: '{}',
  };
  const members = [user, ...others].map((member, index) => ({
    id: `member-${index}`,
    team_id: TEAM,
    user_id: member.user_id,
    username: member.display_name,
    role: index === 0 ? role : index === 1 ? 'admin' : 'member',
    joined_at: date,
    status: 'active',
  }));
  const agent = {
    agent_id: AGENT,
    team_id: TEAM,
    owner_user_id: USER,
    name: 'Research companion',
    description: 'Collects context and prepares a reviewable brief.',
    prompt: 'Prepare concise, evidence-led briefs for human review.',
    visibility: 'team',
    status: 'active',
    created_at: date,
    updated_at: date,
    metadata_json: JSON.stringify({
      ui: {
        icon: '✦',
        accent: 'blue',
        role_prompt: 'Research and synthesis',
        rules_prompt: 'Cite sources. Present proposed changes for review.',
        skills: [],
        code_graphs: [],
        llm_wikis: [],
        chat_memories: [],
      },
    }),
  };
  const tasks = empty
    ? []
    : [
        ['Shape the onboarding journey', 'in_progress', -1, USER, 'high'],
        ['Review the September launch brief', 'review', 0, USER, 'high'],
        ['Map the customer interview findings', 'in_progress', 0, USER, 'medium'],
        ['Write the next product update', 'ready', 1, others[0].user_id, 'medium'],
        ['Explore the knowledge library', 'backlog', 3, USER, 'low'],
        ['Refine the workspace empty states', 'ready', 4, others[1].user_id, 'medium'],
        ['Publish the design principles', 'done', -2, USER, 'medium'],
      ].map(([title, status, offset, assignee, priority], index) => ({
        task_id: `baren-task-${index + 1}`,
        team_id: TEAM,
        creator_user_id: USER,
        title: String(title),
        description:
          'Bring the key decisions together, make the next step clear, and share the result for review.\n\nThis is synthetic preview content.',
        source_type: 'manual',
        source_url: '',
        risk_level: 'low',
        status: status === 'done' ? 'completed' : 'running',
        auto_assign_floating_assets: 0,
        agents:
          index === 2
            ? [
                {
                  id: 'task-agent-1',
                  agent_id: AGENT,
                  task_id: `baren-task-${index + 1}`,
                  status: 'active',
                  created_at: date,
                },
              ]
            : [],
        created_at: date,
        updated_at: date,
        metadata_json: writeTaskBoard(
          JSON.stringify({ ui: { participants: [USER, String(assignee)] } }),
          {
            status: status as BoardStatus,
            assignee: String(assignee),
            priority: priority as 'high' | 'medium' | 'low',
            dueDate: addDays(today, Number(offset)),
            plannedStart: addDays(today, Number(offset) - 2),
            acceptanceCriteria: 'A clear outcome, supporting context, and a reviewable next step.',
          },
        ),
      }));
  const projects = empty
    ? []
    : [
        {
          id: 'baren-project-1',
          name: 'A calmer workspace',
          description: 'Make the day’s priorities clear and keep decisions close to the work.',
          archived: 0,
          canManage: role === 'admin',
        },
        {
          id: 'baren-project-2',
          name: 'Autumn launch',
          description: 'Bring the new experience to the people who need it.',
          archived: 0,
          canManage: role === 'admin',
        },
        {
          id: 'baren-project-3',
          name: 'Customer understanding',
          description: 'Turn research into a shared source of truth.',
          archived: 0,
          canManage: role === 'admin',
        },
      ];
  const assignments = tasks.map((task, index) => ({
    task: task.task_id,
    project_id: projects[index % 3]?.id || '',
  }));
  const areas = empty
    ? []
    : [
        {
          id: 'baren-area-1',
          name: 'Product craft',
          description: 'Build a considered, useful experience.',
          archived: 0,
          canManage: role === 'admin',
        },
        {
          id: 'baren-area-2',
          name: 'Customer relationships',
          description: 'Listen carefully and close the feedback loop.',
          archived: 0,
          canManage: role === 'admin',
        },
      ];
  const loopDefinitions: Omit<Loop, 'today' | 'nextDue' | 'overdue' | 'slots' | 'stats'>[] = empty
    ? []
    : [
        {
          id: 'baren-loop-1',
          name: 'Weekly product review',
          brief: 'Review what shipped, what we learned, and what needs a decision.',
          project_id: 'baren-project-1',
          area_id: 'baren-area-1',
          owner_id: USER,
          mode: 'scheduled',
          start_date: addDays(today, -84),
          frequency: 'weekly',
          target: 1,
          timezone: LOOP_TIMEZONE,
          agents: [],
          archived: 0,
          canManage: true,
        },
        {
          id: 'baren-loop-2',
          name: 'Talk to a customer',
          brief: 'Capture one useful observation and share it with the team.',
          project_id: 'baren-project-3',
          area_id: 'baren-area-2',
          owner_id: USER,
          mode: 'flexible',
          start_date: '',
          frequency: 'weekly',
          target: 2,
          timezone: LOOP_TIMEZONE,
          agents: [AGENT],
          archived: 0,
          canManage: true,
        },
      ];
  const history: Occurrence[] = [];
  const loopTasks: typeof tasks = [];
  if (!empty) {
    // Midday UTC is safely on the specified Madrid day, including across DST changes.
    const at = (offset: number) => Date.parse(`${addDays(today, offset)}T10:00:00Z`);
    const record = (
      loop: (typeof loopDefinitions)[number],
      id: string,
      offset: number,
      state: string,
      completedOffset: number | null,
    ): Occurrence => ({
      id,
      loop_id: loop.id,
      author: USER,
      task_id: state === 'skipped' ? null : `${id}-task`,
      agent_id: '',
      project_id: loop.project_id,
      project_name: projects.find((project) => project.id === loop.project_id)!.name,
      area_id: loop.area_id,
      area_name: areas.find((area) => area.id === loop.area_id)!.name,
      owner_id: loop.owner_id,
      due_day: loop.mode === 'scheduled' ? addDays(today, offset) : '',
      brief: loop.brief,
      period: periodFor(at(offset), LOOP_TIMEZONE, loop.frequency),
      state,
      created_at: at(offset) - 3600000,
      completed_at: completedOffset === null ? null : at(completedOffset),
      note:
        state === 'skipped'
          ? 'The team was away; this review was deliberately skipped.'
          : 'Captured the decision and a clear next step. Synthetic preview history.',
      result_url: '',
      time: [],
    });
    // Twelve elapsed weekly deadlines: seven on time, two late, two skipped,
    // and the unoccupied overdue deadline at -21. Today's deadline is still due.
    const scheduled: [number, number | null][] = [
      [-84, -84],
      [-77, -77],
      [-70, null],
      [-63, -61],
      [-56, -56],
      [-49, -49],
      [-42, -42],
      [-35, null],
      [-28, -28],
      [-14, -11],
      [-7, -7],
    ];
    for (const [offset, completedOffset] of scheduled)
      history.push(
        record(
          loopDefinitions[0],
          `baren-scheduled-${Math.abs(offset)}`,
          offset,
          completedOffset === null ? 'skipped' : 'completed',
          completedOffset,
        ),
      );
    // Completion timestamps span every selectable historical window. Flexible
    // occurrences have no due_day and count in their actual completion period.
    for (const offset of [
      -1, -3, -8, -10, -15, -17, -22, -24, -29, -36, -43, -50, -57, -64, -71, -78, -85,
    ])
      history.push(
        record(
          loopDefinitions[1],
          `baren-flexible-${Math.abs(offset)}`,
          offset,
          'completed',
          offset,
        ),
      );
    const open = record(loopDefinitions[1], 'baren-flexible-open', 0, 'open', null);
    Object.assign(open, { task_id: 'baren-task-3', created_at: now - 1800000, note: '' });
    history.push(open);
    history.sort((a, b) => b.created_at - a.created_at);

    // Historical task details stay available without expanding the seven-task
    // board fixture. Starting a new occurrence adds to the active task list.
    for (const occurrence of history.filter((item) => item.state === 'completed')) {
      const loop = loopDefinitions.find((item) => item.id === occurrence.loop_id)!;
      loopTasks.push({
        ...tasks[6],
        task_id: occurrence.task_id!,
        title: `${loop.name} · ${occurrence.period}`,
        description: occurrence.brief,
        agents: [],
        created_at: new Date(occurrence.created_at).toISOString(),
        updated_at: new Date(occurrence.completed_at!).toISOString(),
        metadata_json: writeTaskBoard(
          JSON.stringify({
            loop_id: loop.id,
            loop_occurrence: occurrence.id,
            area_id: occurrence.area_id,
          }),
          {
            status: 'done',
            assignee: USER,
            dueDate: occurrence.due_day,
          },
        ),
      });
    }
  }
  const loops: Loop[] = loopDefinitions.map((loop) => ({
    ...loop,
    ...scheduleSummary(
      loop,
      history.filter((item) => item.loop_id === loop.id),
      now,
    ),
  }));
  const time = empty
    ? []
    : tasks.slice(0, 4).map((task, index) => ({
        id: `baren-time-${index + 1}`,
        author: index === 3 ? others[0].user_id : USER,
        task: task.task_id,
        title: task.title,
        project: projects[index % 3].name,
        started: now - (index + 1) * 86400000,
        ended: now - (index + 1) * 86400000 + (index + 1) * 1800000,
        seconds: (index + 1) * 1800,
        note: [
          'Mapped the key steps and open questions.',
          'Reviewed the launch narrative.',
          'Synthesized interview notes.',
          'Drafted the update.',
        ][index],
        kind: 'manual',
        review_state: index === 2 ? 'approved' : index === 3 ? 'paid' : 'pending',
        reviewed_by: index > 1 ? USER : null,
        paid_by: index === 3 ? USER : null,
        paid_at: index === 3 ? now : null,
        payment_ref: index === 3 ? 'PREVIEW-001' : null,
      }));
  const knowledge = empty
    ? []
    : [
        {
          knowledge_id: 'baren-wiki-1',
          wiki_id: 'baren-wiki-1',
          team_id: TEAM,
          asset_type: 'llm_wiki',
          name: 'Product field notes',
          description: 'Research, decisions, and shared principles.',
          summary: 'A working collection of product decisions and customer observations.',
          visibility: 'team',
          owner_user_id: USER,
          meta_status: 'approved',
          status: 'ready',
          sync_error: null,
          version: '1',
          page_count: 3,
          last_sync_at: date,
          created_at: date,
          updated_at: date,
        },
      ];
  const code = empty
    ? []
    : [
        {
          knowledge_id: 'baren-code-1',
          code_graph_id: 'baren-code-1',
          team_id: TEAM,
          asset_type: 'code_graph',
          name: 'Workspace application',
          repo_name: 'workspace-app',
          repo_url: 'https://example.invalid/fixture/workspace-app',
          description: 'Synthetic application graph.',
          summary: 'The application shell, task board, and data services.',
          visibility: 'team',
          owner_user_id: USER,
          meta_status: 'approved',
          status: 'ready',
          branch: 'main',
          commit_hash: 'preview123456789',
          version: '1',
          stats: { files: 24, nodes: 86, edges: 128 },
          last_sync_at: date,
          created_at: date,
          updated_at: date,
        },
      ];
  const skills = empty
    ? []
    : [
        {
          skill_id: 'skl-baren-preview',
          name: 'Research brief',
          description: 'Turn source material into a concise, reviewable brief.',
          version: 2,
          is_head: true,
          status: 'active',
          owner_user_id: USER,
          owner_agent_id: AGENT,
          team_id: TEAM,
          task_id: '',
          created_at_ms: now - 86400000,
          updated_at_ms: now,
          content:
            '# Research brief\n\nStart with the question. Gather evidence, separate observations from assumptions, and propose a next step.\n\n## Output\n\n- Main finding\n- Supporting evidence\n- Open questions\n- Recommended next step',
          manifest: [
            { path: 'SKILL.md', size_bytes: 249, mime_type: 'text/markdown', is_executable: false },
          ],
        },
      ];
  const memory = empty
    ? []
    : [
        {
          id: 'baren-memory-1',
          title: 'Product working context',
          summary: 'Shared decisions and useful observations from recent work.',
          uploaded_by_user_id: USER,
          updated_at_ms: now,
          layer_counts: { L0_messages: 4, L1: 2, L2: 1, L3: 1 },
          bound_agent_count: 1,
          agent_id: AGENT,
          scope: 'team',
        },
      ];
  return {
    user,
    users: [user, ...others],
    team,
    members,
    agents: empty ? [] : [agent],
    tasks,
    loopTasks,
    projects,
    assignments,
    areas,
    loops,
    history,
    time,
    knowledge,
    code,
    skills,
    memory,
  };
}
