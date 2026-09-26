import { useNavigate, useSearchParams } from 'react-router-dom';
import Loops from './Loops';
import Areas from './Areas';
import Agenda from './Agenda';
/**
 * TaskWorkbench — 用户工作台。
 *
 * 收敛到两件事：
 *   1. 列出/创建/管理本团队下的 task；
 *   2. 通过 log tab 看 task 历史记录。
 *
 * 布局：进入页面为全宽卡片网格；点击卡片拉出 Drawer，在抽屉内查看详情与设置
 * （改状态、编辑标题/描述、删除）。
 *
 * 数据走后端链路 A（services/backendStore.ts，内部调用 @/lib/teamApi 的 meta 接口）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Text } from 'tea-component';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  canDeleteTask,
  canEditTask,
} from '@/services';
import { tea } from '@/lib/tea-bridge';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import BoardView from './BoardView';
import { projectRequest, projectsChanged, type Project } from '../hooks/useProjects';
import Timesheets from './Timesheets';
import { useTeamParticipation } from '../hooks/useTeamParticipation';
import { errMsg, type AgentOption, type WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">
          {t('task.emptyTeam.title')}
        </Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('task.emptyTeam.desc')}
        </Text>
      </Card.Body>
    </Card>
  );
}

export default function TaskWorkbench(props: {
  view?: 'board' | 'timesheets' | 'loops' | 'areas' | 'today' | 'upcoming';
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  /** 当前激活的 team id（可空：未选时只显示 empty state） */
  activeTeamId: string | null;
  /** 当前用户名（task 的 creator_user_id） */
  currentUser: string;
  /** 当前 team 下可关联的 Agent 列表（来自 TeamManagementPanel 的同源数据） */
  agents: AgentOption[];
  /** 是否为全局 admin（保留接口兼容；admin 不再有 task 特权） */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const { activeTeamId, currentUser, agents, view = 'board' } = props;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // 后端分页：useTasks 根据 page + pageSize 调 Panel 聚合接口，内核只返回当前页
  const PAGE_SIZE = 0; // The board loads all pages so columns and filters are complete.
  const currentPage = 1;
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    retry: retryTasks,
  } = useTasks(activeTeamId, currentPage, PAGE_SIZE);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  const [createProject, setCreateProject] = useState<Project | undefined>();
  const previousTeam = useRef(activeTeamId);
  useEffect(() => {
    if (!activeTeamId) return;
    const changedTeam = previousTeam.current && previousTeam.current !== activeTeamId;
    previousTeam.current = activeTeamId;
    if (!changedTeam) return;
    setShowCreate(false);
    setCreateProject(undefined);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['project', 'projectDetails', 'manageProjects', 'task']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [activeTeamId, setSearchParams]);
  const selectedId = searchParams.get('task');
  const setSelectedId = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('task', id);
    else next.delete('task');
    setSearchParams(next, { replace: true });
  };

  // 切换 team 时重置到第 1 页

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }, [tasks]);

  const selected = useMemo(
    () => (selectedId ? (tasks.find((t) => t.task_id === selectedId) ?? null) : null),
    [selectedId, tasks],
  );

  /**
   * 创建 task：team_id 完全由当前激活 team 决定，不再让 dialog 选 team
   * （切 team 的唯一入口在右上角全局 TeamSwitcher）。
   */
  async function handleCreate(draft: TaskDraft) {
    // 谁点击「创建 Task」，谁就是 creator_user_id。
    const team = teams.find((t) => t.team_id === draft.team_id);
    if (!team) {
      throw new Error(t('task.emptyTeam.title'));
    }
    // The creation dialog owns its retryable error state.
    const task = await createTask({
      team_id: draft.team_id,
      creator_user_id: currentUser,
      title: draft.title,
      description: draft.description,
      source_type: draft.source_type,
      source_url: draft.source_url,
      linked_agents: draft.linked_agents,
    });
    if (view === 'board' && createProject) {
      try {
        await projectRequest(draft.team_id, 'assign', {
          task: task.task_id,
          projectId: createProject.id,
        });
        projectsChanged();
      } catch (error) {
        // Creation succeeded. Open that task instead of offering a duplicate creation retry.
        tea.notify.warning(
          `Task created, but its project could not be assigned: ${errMsg(error)}. You can assign it in task details.`,
        );
      }
    }
    setShowCreate(false);
    setCreateProject(undefined);
    if (view === 'board') setSelectedId(task.task_id);
    else navigate('/?task=' + encodeURIComponent(task.task_id));
  }

  return (
    <div className="_memory-workbench-body">
      {!activeTeamId ? (
        <EmptyTeam />
      ) : (
        <>
          {/* 当前 team 概览（与 team 管理页同一组件） */}
          {view === 'areas' ? (
            <Areas key={activeTeamId} teamId={activeTeamId} />
          ) : view === 'today' || view === 'upcoming' ? (
            <Agenda
              key={activeTeamId}
              view={view}
              teamId={activeTeamId}
              tasks={tasks}
              loading={tasksLoading}
              error={tasksError}
              onRetry={retryTasks}
              currentUser={currentUser}
              onCreate={() => setShowCreate(true)}
              onOpenBoard={() => navigate('/')}
              onOpenTask={(id) => navigate('/?task=' + encodeURIComponent(id))}
              onOpenLoops={(id, due) =>
                navigate(
                  '/loops' +
                    (id
                      ? '?loop=' +
                        encodeURIComponent(id) +
                        (due ? '&due=' + encodeURIComponent(due) : '')
                      : ''),
                )
              }
            />
          ) : view === 'loops' ? (
            <Loops
              initialLoop={searchParams.get('loop') || ''}
              initialDue={searchParams.get('due') || ''}
              key={activeTeamId}
              members={activeTeam?.members}
              teamId={activeTeamId}
              currentUser={currentUser}
              agents={agents}
              onOpenTask={(id) => navigate('/?task=' + encodeURIComponent(id))}
            />
          ) : view === 'timesheets' ? (
            <Timesheets key={activeTeamId} teamId={activeTeamId} />
          ) : (
            <BoardView
              key={activeTeamId}
              teamId={activeTeamId}
              tasks={sortedTasks}
              tasksLoading={tasksLoading}
              tasksError={tasksError}
              onRetryTasks={retryTasks}
              selected={selected}
              onSelect={(id) => setSelectedId(id)}
              onCreate={(project) => {
                setCreateProject(project);
                setShowCreate(true);
              }}
              onDelete={async (task) => {
                // 权限：删除 task 仅创建者 / team admin / 全局 admin
                const team = teams.find((t) => t.team_id === task.team_id) ?? null;
                if (!canDeleteTask(task, team, currentUser)) {
                  tea.notify.warning(
                    t('task.delete.noPermission', {
                      title: task.title,
                      creator: task.creator_user_id,
                    }),
                  );
                  return;
                }
                const ok = await tea.confirm({
                  message: t('task.delete.confirm', { title: task.title }),
                  description: t('task.delete.description', { id: task.task_id }),
                  okText: t('task.delete.okText'),
                  cancelText: t('task.delete.cancelText'),
                });
                if (ok) {
                  try {
                    await deleteTask(task.task_id);
                    if (selectedId === task.task_id) setSelectedId(null);
                  } catch (err) {
                    tea.notify.error(errMsg(err));
                  }
                }
              }}
              onUpdateTask={async (task, patch) => {
                const team = teams.find((t) => t.team_id === task.team_id);
                if (!canEditTask(task, team, currentUser)) {
                  tea.notify.warning(t('task.noPermissionEdit'));
                  return false;
                }
                try {
                  await updateTask(task.task_id, patch, currentUser);
                  return true;
                } catch (err) {
                  tea.notify.error(errMsg(err));
                  return false;
                }
              }}
              agents={agents}
              teams={teams}
              currentUser={currentUser}
              participationByTask={participationByTask}
            />
          )}
        </>
      )}

      {showCreate && activeTeam && (
        // team 由右上角全局 TeamSwitcher 决定，dialog 里不再让用户选；
        // 这里 activeTeam 必为非空，因为上面 !activeTeamId 分支已经走 EmptyTeam 了
        <TaskCreateDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          projectName={createProject?.name}
          onClose={() => {
            setShowCreate(false);
            setCreateProject(undefined);
          }}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
