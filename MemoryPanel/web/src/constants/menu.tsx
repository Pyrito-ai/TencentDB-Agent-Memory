/**
 * 菜单元数据 — 从 App.tsx 抽出
 *
 * 包含页面 ID 类型、页面元信息、分组排序、分组图标。
 * Sidebar / TabBar / 路由等模块共用。
 */
import { useTranslation } from 'react-i18next';
import {
  DashboardIcon,
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';

export type PageId =
  | 'projects'
  | 'orca_workbench'
  | 'workbench_board'
  | 'today'
  | 'upcoming'
  | 'timesheets'
  | 'areas'
  | 'loops'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'team_members'
  | 'team_agents'
  | 'api_keys'
  | 'analytics';

/** 页面元数据 */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** 所属分组，用于侧边栏菜单分组标题 */
  group: string;
  /** 分组内排序，越小越靠前 */
  order: number;
  /** 固定标签页不可关闭（工作台看板） */
  affix?: boolean;
}

// 使用 useTranslation 的 hook 版本
export function usePageMeta(): Record<PageId, PageMeta> {
  const { t } = useTranslation();
  return {
    projects: { id: 'projects', label: 'Projects', group: t('menu.group.workbench'), order: 0.5 },
    orca_workbench: { id: 'orca_workbench', label: 'Workbench', desc: 'Coordinate subscription workers with Orca', group: t('menu.group.workbench'), order: 3 },
    workbench_board: { id: 'workbench_board', label: t('menu.workbench_board'), desc: t('menu.desc.workbench_board'), group: t('menu.group.workbench'), order: 0, affix: true },
    today: { id: 'today', label: 'Today', group: t('menu.group.workbench'), order: -2 },
    upcoming: { id: 'upcoming', label: 'Upcoming', group: t('menu.group.workbench'), order: -1 },
    timesheets: { id: 'timesheets', label: t('menu.timesheets'), group: t('menu.group.workbench'), order: 4 },
    areas: { id: 'areas', label: 'Areas', group: t('menu.group.workbench'), order: 1 },
    loops: { id: 'loops', label: t('menu.loops'), group: t('menu.group.workbench'), order: 2 },
    analytics:      { id: 'analytics',      label: t('menu.analytics'), desc: t('menu.desc.analytics'), group: t('menu.group.observability'), order: 0 },
    wiki:            { id: 'wiki',            label: t('menu.wiki'), desc: t('menu.desc.wiki'), group: t('menu.group.assets'), order: 2 },
    code:            { id: 'code',            label: t('menu.code'), desc: t('menu.desc.code'), group: t('menu.group.assets'), order: 3 },
    skills:          { id: 'skills',          label: t('menu.skills'), desc: t('menu.desc.skills'), group: t('menu.group.assets'), order: 4 },
    chat_memory:     { id: 'chat_memory',     label: t('menu.chat_memory'), desc: t('menu.desc.chat_memory'), group: t('menu.group.assets'), order: 5 },
    team_members:    { id: 'team_members',    label: t('menu.team_members'), desc: t('menu.desc.team_members'), group: t('menu.group.organization'), order: 0 },
    team_agents:     { id: 'team_agents',     label: t('menu.team_agents'), desc: t('menu.desc.team_agents'), group: t('menu.group.organization'), order: 1 },
    api_keys:        { id: 'api_keys',        label: t('menu.api_keys'), desc: t('menu.desc.api_keys'), group: t('menu.group.organization'), order: 2 },
  };
}

/** 分组排序顺序 */
export const GROUP_ORDER_KEYS = ['workbench', 'observability', 'organization', 'assets'] as const;

/** 每个页面在侧边栏菜单中的图标（Tea 官方图标，size 16） */
export const ITEM_ICON: Record<PageId, JSX.Element> = {
  projects: <BooksIcon size={16} />,
  orca_workbench: <ToolsIcon size={16} />,
  workbench_board: <DashboardIcon size={16} />,
  today: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></svg>,
  upcoming: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-14 5h3m4 0h3"/></svg>,
  timesheets: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  areas: <DashboardIcon size={16}/>,
  loops: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>,
  analytics: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="10" width="3" height="6" rx="0.8" />
      <rect x="10.5" y="6" width="3" height="10" rx="0.8" />
      <rect x="15" y="13" width="3" height="3" rx="0.8" />
    </svg>
  ),
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
};

/** 分组图标（工作台 / 可观测 / 组织与权限 / 资产管理） */
export const GROUP_ICON: Record<string, JSX.Element> = {
  workbench: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  observability: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  organization: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  assets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
};
