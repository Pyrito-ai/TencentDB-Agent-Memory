import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer } from 'tea-component';
import { canEditTask, canDeleteTask, type Task, type TaskPatch, type Team } from '@/services';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { BOARD_STATUSES, PRIORITIES, readTaskBoard, type BoardStatus } from '@/services/task-board';
import TaskDetail from './TaskDetail';
import { participationOf, type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';
import '../styles/project-board.css';

export default function BoardView({ tasks, tasksLoading, selected, onSelect, onCreate, onDelete,
  onUpdateTask, agents, teams, currentUser, participationByTask }: {
  tasks: Task[]; tasksLoading: boolean; selected: Task | null;
  onSelect: (id: string | null) => void; onCreate: () => void; onDelete: (task: Task) => void;
  onUpdateTask: (task: Task, patch: TaskPatch) => Promise<boolean>;
  agents: AgentOption[]; teams: Team[]; currentUser: string;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  const resolveName = useDisplayNameResolver();
  const [query, setQuery] = useState('');
  const [assignee, setAssignee] = useState('all');
  const [priority, setPriority] = useState('all');
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<BoardStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const selectedTeam = teams.find(x => x.team_id === selected?.team_id) ?? null;
  const members = [...new Set(tasks.map(task => readTaskBoard(task).assignee).filter(Boolean))];
  const filtered = tasks.filter(task => {
    const board = readTaskBoard(task);
    return `${task.title} ${task.description}`.toLowerCase().includes(query.toLowerCase())
      && (assignee === 'all' || board.assignee === assignee)
      && (priority === 'all' || board.priority === priority);
  });
  async function move(task: Task, status: BoardStatus) {
    if (pending || tasksLoading || readTaskBoard(task).status === status) return;
    if (!canEditTask(task, teams.find(x => x.team_id === task.team_id), currentUser)) return;
    setPending(task.task_id);
    try {
      if (await onUpdateTask(task, { board: { status } })) {
        setAnnouncement(t('board.moved', { title: task.title, status: t(`board.status.${status}`) }));
      }
    } finally { setPending(null); setDragged(null); setOver(null); }
  }
  return <div className="project-board">
    <header className="project-board-header">
      <div><h2>{t('board.title')}</h2><p>{t('board.subtitle')}</p></div>
      <Button type="primary" onClick={onCreate}>{t('task.create')}</Button>
    </header>
    <div className="project-board-filters">
      <input aria-label={t('board.search')} placeholder={t('board.search')} value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label={t('board.assignee')} value={assignee} onChange={e => setAssignee(e.target.value)}>
        <option value="all">{t('board.allAssignees')}</option><option value="">{t('board.unassigned')}</option>
        {members.map(id => <option key={id} value={id}>{resolveName(id)}</option>)}
      </select>
      <select aria-label={t('board.priority')} value={priority} onChange={e => setPriority(e.target.value)}>
        <option value="all">{t('board.allPriorities')}</option>
        {PRIORITIES.map(p => <option key={p} value={p}>{t(`board.priority.${p}`)}</option>)}
      </select>
      <span>{t('board.count', { count: filtered.length })}</span>
    </div>
    <div className="project-board-live" role="status" aria-live="polite">{announcement}</div>
    {tasksLoading && <p role="status">{t('board.loading')}</p>}
    <div className="project-board-columns" aria-busy={tasksLoading}>
      {BOARD_STATUSES.map(status => {
        const column = filtered.filter(task => readTaskBoard(task).status === status);
        return <section key={status} className={`project-board-column ${over === status ? 'is-over' : ''}`}
          aria-label={t(`board.status.${status}`)}
          onDragOver={e => { if (dragged && !pending) { e.preventDefault(); setOver(status); } }}
          onDrop={e => { e.preventDefault(); const task = tasks.find(x => x.task_id === dragged); if (task) void move(task, status); setOver(null); }}>
          <h3><span className={`project-board-dot ${status}`} />{t(`board.status.${status}`)} <span className="project-board-count">{column.length}</span></h3>
          {column.map(task => {
            const board = readTaskBoard(task);
            const participation = participationOf(participationByTask, task.task_id);
            const editable = canEditTask(task, teams.find(x => x.team_id === task.team_id), currentUser);
            return <article key={task.task_id} className={`project-board-card ${pending === task.task_id ? 'is-saving' : ''}`}
              draggable={editable && !pending && !tasksLoading}
              onDragStart={e => { e.dataTransfer.setData('text/plain', task.task_id); e.dataTransfer.effectAllowed = 'move'; setDragged(task.task_id); }}
              onDragEnd={() => { setDragged(null); setOver(null); }}>
              <button className="project-board-card-open" onClick={() => onSelect(task.task_id)}>
                {board.priority !== 'none' && <span className={`project-board-priority ${board.priority}`}>{t(`board.priority.${board.priority}`)}</span>}
                <strong>{task.title}</strong>
                {task.description && <p>{task.description}</p>}
                <span className="project-board-card-meta">{board.assignee ? resolveName(board.assignee) : t('board.unassigned')}{board.dueDate && ` · ${board.dueDate}`}</span>
                <span className="project-board-card-meta">{t('board.agentCount', { count: task.linked_agents.length })} · {t('task.peopleCount', { count: participation.users.length })}</span>
              </button>
              <select aria-label={t('board.moveTask', { title: task.title })} value={board.status}
                disabled={!editable || !!pending || tasksLoading} onChange={e => void move(task, e.target.value as BoardStatus)}>
                {BOARD_STATUSES.map(s => <option key={s} value={s}>{t(`board.status.${s}`)}</option>)}
              </select>
            </article>;
          })}
          {!column.length && <p className="project-board-empty">{t('board.emptyColumn')}</p>}
        </section>;
      })}
    </div>
    <Drawer visible={!!selected} size="l" onClose={() => onSelect(null)} title={selected?.title}
      subtitle={selected ? `${selectedTeam?.name ?? ''} · ${selected.task_id}` : undefined} destroyOnClose>
      {selected && <TaskDetail key={selected.task_id} task={selected} onUpdateTask={patch => onUpdateTask(selected, patch)}
        onDelete={() => onDelete(selected)} canDelete={canDeleteTask(selected, selectedTeam, currentUser)}
        agents={agents} team={selectedTeam} currentUser={currentUser} participation={participationOf(participationByTask, selected.task_id)} />}
    </Drawer>
  </div>;
}
