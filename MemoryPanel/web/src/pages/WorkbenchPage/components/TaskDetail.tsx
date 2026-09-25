import { WikiConnections } from '@/pages/OrcaWorkbench/WikiConnections';
import { TaskHandoff } from '@/pages/OrcaWorkbench/TaskHandoff';
import '@/pages/OrcaWorkbench/workbench.css';
import { TaskProject } from './Projects';
import TaskTime from './TaskTime';
import TaskActivity from './TaskActivity';
import { BOARD_STATUSES, PRIORITIES, readTaskBoard } from '@/services/task-board';
/**
 * TaskDetail —— 工作台任务详情（编辑标题/描述、切换状态、查看参与者、删除）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Text } from 'tea-component';
import { DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import { canEditTask, type Task, type TaskPatch, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';

/**
 * 参与者 chip：可见文本显示 display_name（缓存未命中先回退 id），
 * title 保留语义 tooltip + user_id 供排查。
 * 抽子组件是 Rules of Hooks 要求（不能在 .map 里循环调 useUserDisplayName）。
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateTask: (patch: TaskPatch) => Promise<boolean>;
  /** 删除当前 task（权限校验与二次确认由外层统一处理） */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** 当前 task 所属 team — 可能为 null（理论上不会，但 team 被删除场景需兜底） */
  team: Team | null;
  currentUser: string;
  /** 从 useTeamParticipation 分桶后传下来的当前 task 观测数据 */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const board = readTaskBoard(task);
  const [draftBoard, setDraftBoard] = useState(board);
  const [saving, setSaving] = useState(false);
  // 编辑权限：team 内任意 member 可改 task（含切换 status）。
  const canEdit = canEditTask(task, team, currentUser);

  // —— 编辑态：只在用户点「编辑」后才进入；草稿独立维护，取消即丢弃 —— //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setDraftBoard(readTaskBoard(task));
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  async function saveEdit() {
    const patch: TaskPatch = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (draftBoard.plannedStart && draftBoard.dueDate && draftBoard.plannedStart > draftBoard.dueDate) {
      tea.notify.warning('Planned start must be on or before the due date.');
      return;
    }
    const boardPatch = Object.fromEntries(Object.entries(draftBoard).filter(([key, value]) => value !== board[key as keyof typeof board]));
    if (Object.keys(boardPatch).length) patch.board = boardPatch;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try { if (await onUpdateTask(patch)) setEditing(false); } finally { setSaving(false); }
  }

  // 参与者展示：creator 单列独立；其余进 "参与的 User"。
  // 数据源统一走 participation-log 观测 —— proxy session init 完成时 append 的
  // "实际起过 session 的 user"。creator 用自己的 agent 开工也算一次真实参与，
  // 所以不再过滤 creator（会同时出现在"创建者"和"参与的 User"两处，语义不同）。
  const participantUsers = participation.users;

  // 「实际参与 Agent」：session 观测到的 agent，映射到 team 的 agent name；
  // 未在 team agents 列表里的（比如已被删除）保留 agent_id 兜底展示。
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return participation.agentIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === 工具行：编辑 + 状态切换（标题 / task_id / team 已在抽屉头部展示） === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button disabled={saving} onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" disabled={saving} onClick={() => void saveEdit()}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            <span className="project-board-detail-status">{t(`board.status.${board.status}`)}</span>
          </>
        )}
      </div>

      <fieldset className="project-board-fields" disabled={!editing || saving}>
        <legend>{t('board.planning')}</legend>
        <label>{t('board.workflow')}<select value={(editing ? draftBoard : board).status} onChange={e => setDraftBoard({ ...draftBoard, status: e.target.value as typeof board.status })}>
          {BOARD_STATUSES.map(s => <option key={s} value={s}>{t(`board.status.${s}`)}</option>)}
        </select></label>
        <label>{t('board.assignee')}<select value={(editing ? draftBoard : board).assignee} onChange={e => setDraftBoard({ ...draftBoard, assignee: e.target.value })}>
          <option value="">{t('board.unassigned')}</option>
          {team?.members.map(m => <option key={m.user_id} value={m.user_id}>{m.username || m.user_id}</option>)}
          {board.assignee && !team?.members.some(m => m.user_id === board.assignee) && <option value={board.assignee}>{board.assignee}</option>}
        </select></label>
        <label>{t('board.priority')}<select value={(editing ? draftBoard : board).priority} onChange={e => setDraftBoard({ ...draftBoard, priority: e.target.value as typeof board.priority })}>
          {PRIORITIES.map(p => <option key={p} value={p}>{t(`board.priority.${p}`)}</option>)}
        </select></label>
        <label>Planned start<input type="date" value={(editing ? draftBoard : board).plannedStart} onChange={e => setDraftBoard({ ...draftBoard, plannedStart: e.target.value })} /></label>
        <label>{t('board.dueDate')}<input type="date" value={(editing ? draftBoard : board).dueDate} onChange={e => setDraftBoard({ ...draftBoard, dueDate: e.target.value })} /></label>
      </fieldset>
      <p className="project-board-detail-note">{t('board.sessionNote')}</p>
      {/* === 描述 === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      <div className="_memory-workbench-block">
        <label className="project-board-criteria-label">{t('board.criteria')}
          {editing ? <textarea rows={5} disabled={saving} value={draftBoard.acceptanceCriteria} onChange={e => setDraftBoard({ ...draftBoard, acceptanceCriteria: e.target.value })} />
            : <div className="_memory-workbench-desc-view">{board.acceptanceCriteria || t('board.noCriteria')}</div>}
        </label>
      </div>
      <div className="_memory-workbench-block">
        <Text theme="label">{t('board.linkedAgents')}</Text>
        <p>{task.linked_agents.map(id => agents.find(a => a.id === id)?.name ?? id).join(', ') || '—'}</p>
      </div>
      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      <TaskProject teamId={task.team_id} taskId={task.task_id} canEdit={canEdit}/>
      <WikiConnections key={`wiki-${task.task_id}`} team={task.team_id} kind="task" id={task.task_id} />
      <TaskHandoff key={`handoff-${task.task_id}`} team={task.team_id} taskId={task.task_id} />
      <TaskTime key={task.task_id} taskId={task.task_id} currentUser={currentUser} />
      <TaskActivity key={task.task_id} taskId={task.task_id} creator={task.creator_user_id} currentUser={currentUser} />

      <details className="project-board-agent-details"><summary>{t('board.participation')}</summary>
      {/* === 参与者 === */}
      <div className="_memory-workbench-people">
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      </details>

      {/* === 危险操作 === */}
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
