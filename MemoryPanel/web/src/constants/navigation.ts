import type { PageId } from './menu';

/** Keep URLs stable: the board still lives at / and existing deep links remain valid. */
export const PAGE_PATHS: Record<PageId, string> = {
  workbench_board: '/',
  today: '/today',
  upcoming: '/upcoming',
  projects: '/projects',
  areas: '/areas',
  loops: '/loops',
  timesheets: '/timesheets',
  orca_workbench: '/workbench',
  wiki: '/wiki',
  code: '/code',
  skills: '/skills',
  chat_memory: '/memory',
  team_members: '/team/members',
  team_agents: '/team/agents',
  api_keys: '/team/api-keys',
  analytics: '/analytics',
};

export const DOCK_PAGES: PageId[] = [
  'today',
  'workbench_board',
  'loops',
  'orca_workbench',
  'wiki',
  'chat_memory',
];
export const MORE_GROUPS: { label: string; pages: PageId[] }[] = [
  { label: 'Work', pages: ['upcoming', 'areas', 'timesheets'] },
  { label: 'Resources', pages: ['code', 'skills'] },
  {
    label: 'Team & administration',
    pages: ['team_members', 'team_agents', 'api_keys', 'analytics'],
  },
];
export const NAV_LABELS: Record<PageId, string> = {
  today: 'Today',
  workbench_board: 'Task board',
  projects: 'Projects',
  loops: 'Loops',
  orca_workbench: 'Workbench',
  wiki: 'Knowledge',
  chat_memory: 'Memory',
  upcoming: 'Upcoming',
  areas: 'Areas',
  timesheets: 'Timesheets',
  code: 'Code',
  skills: 'Skills',
  team_members: 'Members',
  team_agents: 'Agents',
  api_keys: 'API Keys',
  analytics: 'Analytics',
};

export function pageForPath(path: string): PageId | null {
  if (path === '/guide') return null;
  if (path === '/projects' || path.startsWith('/projects/')) return 'workbench_board';
  return (
    (Object.entries(PAGE_PATHS).find(
      ([, url]) => url !== '/' && (path === url || path.startsWith(`${url}/`)),
    )?.[0] as PageId | undefined) ?? 'workbench_board'
  );
}

export function visiblePageIds(role: string | null, analyticsEnabled: boolean): PageId[] {
  return (Object.keys(PAGE_PATHS) as PageId[]).filter(
    (id) =>
      id !== 'projects' &&
      !(id === 'team_members' && role === 'reviewer') &&
      !(id === 'analytics' && (role !== 'admin' || !analyticsEnabled)),
  );
}

/** Project bookmarks now open project management within the task board. */
export function projectBoardLocation(id: string): string {
  return '/?' + new URLSearchParams({ project: id, projectDetails: id });
}

export function legacyProjectsLocation(search: string): string {
  const params = new URLSearchParams(search);
  const id = params.get('id');
  params.delete('id');
  if (id) {
    params.set('project', id);
    params.set('projectDetails', id);
  } else {
    params.set('manageProjects', '1');
  }
  return '/?' + params;
}
