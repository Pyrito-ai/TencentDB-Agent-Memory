import { ProjectManager } from './ProjectManager';
import { useSearchParams } from 'react-router-dom';
import { useProjects, type Project } from '../hooks/useProjects';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer } from 'tea-component';
import { Badge } from '@/components/baren';
import { canEditTask, canDeleteTask, type Task, type TaskPatch, type Team } from '@/services';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { BOARD_STATUSES, PRIORITIES, readTaskBoard, type BoardStatus } from '@/services/task-board';
import TaskDetail from './TaskDetail';
import {
  participationOf,
  type AgentOption,
  type TaskParticipationView,
} from '../utils/workbench-utils';
import '../styles/project-board.css';

export default function BoardView({
  tasks,
  tasksLoading,
  tasksError,
  onRetryTasks,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onUpdateTask,
  agents,
  teams,
  currentUser,
  participationByTask,
  teamId,
}: {
  teamId?: string;
  tasks: Task[];
  tasksLoading: boolean;
  tasksError?: string | null;
  onRetryTasks?: () => void;
  selected: Task | null;
  onSelect: (id: string | null) => void;
  onCreate: (project?: Project) => void;
  onDelete: (task: Task) => void;
  onUpdateTask: (task: Task, patch: TaskPatch) => Promise<boolean>;
  agents: AgentOption[];
  teams: Team[];
  currentUser: string;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  const projectTeam = teamId || tasks[0]?.team_id || teams[0]?.team_id || '';
  const projects = useProjects(projectTeam);
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = searchParams.get('project') ?? 'all';
  const selectedProject = projects.items.find((project) => project.id === projectFilter);
  const projectDetails = searchParams.get('projectDetails');
  const managingProjects = searchParams.has('manageProjects') || !!projectDetails;
  function changeProjectFilter(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id === 'all') next.delete('project');
    else next.set('project', id);
    setSearchParams(next);
  }
  function manageProjects(id: string | null) {
    const next = new URLSearchParams(searchParams);
    next.set('manageProjects', '1');
    if (id) next.set('projectDetails', id);
    else next.delete('projectDetails');
    setSearchParams(next);
  }
  function closeProjects(viewProject?: string) {
    const next = new URLSearchParams(searchParams);
    next.delete('manageProjects');
    next.delete('projectDetails');
    if (viewProject) {
      next.set('project', viewProject);
      next.delete('task');
      setQuery('');
      setAssignee('all');
      setPriority('all');
    }
    setSearchParams(next);
  }
  const taskProject = (id: string) =>
    projects.assignments.find((a) => a.task === id)?.project_id || '';
  const resolveName = useDisplayNameResolver();
  const [query, setQuery] = useState('');
  const [assignee, setAssignee] = useState('all');
  const [priority, setPriority] = useState('all');
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<BoardStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const selectedTeam = teams.find((x) => x.team_id === selected?.team_id) ?? null;
  const members = [...new Set(tasks.map((task) => readTaskBoard(task).assignee).filter(Boolean))];
  const filtered = tasks.filter((task) => {
    const board = readTaskBoard(task);
    return (
      `${task.title} ${task.description}`.toLowerCase().includes(query.toLowerCase()) &&
      (assignee === 'all' || board.assignee === assignee) &&
      (priority === 'all' || board.priority === priority) &&
      (projectFilter === 'all' || taskProject(task.task_id) === projectFilter)
    );
  });
  async function move(task: Task, status: BoardStatus) {
    if (pending || tasksLoading || readTaskBoard(task).status === status) return;
    if (
      !canEditTask(
        task,
        teams.find((x) => x.team_id === task.team_id),
        currentUser,
      )
    )
      return;
    setPending(task.task_id);
    try {
      if (await onUpdateTask(task, { board: { status } })) {
        setAnnouncement(
          t('board.moved', { title: task.title, status: t(`board.status.${status}`) }),
        );
      }
    } finally {
      setPending(null);
      setDragged(null);
      setOver(null);
    }
  }
  return (
    <div className="project-board">
      <header className="project-board-header work-page-header">
        <div>
          <h2>{t('board.title')}</h2>
        </div>
        <div className="board-heading-actions">
          <Button onClick={() => manageProjects(null)}>Manage projects</Button>
          <Button
            type="primary"
            className="work-primary"
            disabled={
              !!selectedProject?.archived ||
              (!!projectFilter && projectFilter !== 'all' && !selectedProject)
            }
            onClick={() => onCreate(selectedProject)}
          >
            <Plus size={16} aria-hidden="true" />
            New task
          </Button>
        </div>
      </header>
      <div className="project-board-filters board-task-filters">
        <select
          aria-label="Filter by project"
          value={projectFilter}
          disabled={!projects.loaded}
          onChange={(e) => changeProjectFilter(e.target.value)}
        >
          <option value="all">All projects</option>
          <option value="">Unassigned</option>
          {projects.items.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {project.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
        <input
          aria-label={t('board.search')}
          placeholder={t('board.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={t('board.assignee')}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="all">{t('board.allAssignees')}</option>
          <option value="">{t('board.unassigned')}</option>
          {members.map((id) => (
            <option key={id} value={id}>
              {resolveName(id)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('board.priority')}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="all">{t('board.allPriorities')}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`board.priority.${p}`)}
            </option>
          ))}
        </select>
        {!tasksLoading && !tasksError && (
          <span>{t('board.count', { count: filtered.length })}</span>
        )}
      </div>
      {selectedProject && (
        <section className="board-project-context" aria-label="Selected project">
          <div>
            <strong>{selectedProject.name}</strong>
            {selectedProject.archived ? (
              <p>Archived project. Restore it in project details to add tasks.</p>
            ) : selectedProject.description ? (
              <p>{selectedProject.description}</p>
            ) : null}
          </div>
          <Button onClick={() => manageProjects(selectedProject.id)}>Project details</Button>
        </section>
      )}
      {projects.error && <p role="alert">{projects.error}</p>}
      {projects.loaded && projectFilter && projectFilter !== 'all' && !selectedProject && (
        <p role="alert">This project is unavailable. Select another project or view all tasks.</p>
      )}
      <div className="project-board-live" role="status" aria-live="polite">
        {announcement}
      </div>
      {tasksLoading && <p role="status">{t('board.loading')}</p>}
      {tasksError && (
        <div className="work-load-error" role="alert">
          <div>
            <strong>Tasks could not be loaded</strong>
            <p>{tasksError}</p>
          </div>
          {onRetryTasks && <button onClick={onRetryTasks}>Retry tasks</button>}
        </div>
      )}
      {!tasksLoading && !tasksError && (
        <div className="project-board-columns">
          {BOARD_STATUSES.map((status) => {
            const column = filtered.filter((task) => readTaskBoard(task).status === status);
            return (
              <section
                key={status}
                className={`project-board-column ${over === status ? 'is-over' : ''}`}
                aria-label={t(`board.status.${status}`)}
                onDragOver={(e) => {
                  if (dragged && !pending) {
                    e.preventDefault();
                    setOver(status);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const task = tasks.find((x) => x.task_id === dragged);
                  if (task) void move(task, status);
                  setOver(null);
                }}
              >
                <h3>
                  <span className={`project-board-dot ${status}`} />
                  {t(`board.status.${status}`)}{' '}
                  <span className="project-board-count">{column.length}</span>
                </h3>
                {column.map((task) => {
                  const board = readTaskBoard(task);
                  const participation = participationOf(participationByTask, task.task_id);
                  const editable = canEditTask(
                    task,
                    teams.find((x) => x.team_id === task.team_id),
                    currentUser,
                  );
                  return (
                    <article
                      key={task.task_id}
                      className={`project-board-card ${pending === task.task_id ? 'is-saving' : ''}${selected?.task_id === task.task_id ? ' is-selected' : ''}`}
                      draggable={editable && !pending && !tasksLoading}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', task.task_id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragged(task.task_id);
                      }}
                      onDragEnd={() => {
                        setDragged(null);
                        setOver(null);
                      }}
                    >
                      <button
                        className="project-board-card-open"
                        onClick={() => onSelect(task.task_id)}
                      >
                        {board.priority !== 'none' && (
                          <Badge className={`project-board-priority ${board.priority}`}>
                            {t(`board.priority.${board.priority}`)}
                          </Badge>
                        )}
                        <strong>{task.title}</strong>
                        {taskProject(task.task_id) && (
                          <span className="project-board-card-meta">
                            {projects.items.find((p) => p.id === taskProject(task.task_id))?.name}
                          </span>
                        )}
                        {task.description && <p>{task.description}</p>}
                        <span className="project-board-card-person">
                          <span className="work-avatar" aria-hidden="true">
                            {board.assignee
                              ? resolveName(board.assignee).slice(0, 2).toUpperCase()
                              : '—'}
                          </span>
                          <span>
                            {board.assignee ? resolveName(board.assignee) : t('board.unassigned')}
                            {board.dueDate && <small>{board.dueDate}</small>}
                          </span>
                        </span>
                        <span className="project-board-card-meta">
                          {t('board.agentCount', { count: task.linked_agents.length })} ·{' '}
                          {t('task.peopleCount', { count: participation.users.length })}
                        </span>
                      </button>
                    </article>
                  );
                })}
                {!column.length && <p className="project-board-empty">{t('board.emptyColumn')}</p>}
              </section>
            );
          })}
        </div>
      )}
      {managingProjects && (
        <ProjectManager
          teamId={projectTeam}
          selectedProjectId={projectDetails}
          onSelectProject={manageProjects}
          onViewTasks={(id) => closeProjects(id)}
          onClose={() => closeProjects()}
        />
      )}
      <Drawer
        visible={!!selected && !managingProjects}
        size="l"
        onClose={() => onSelect(null)}
        title={selected?.title}
        subtitle={selected ? `${selectedTeam?.name ?? ''} · ${selected.task_id}` : undefined}
        destroyOnClose
      >
        {selected && (
          <TaskDetail
            key={selected.task_id}
            task={selected}
            onUpdateTask={(patch) => onUpdateTask(selected, patch)}
            onDelete={() => onDelete(selected)}
            canDelete={canDeleteTask(selected, selectedTeam, currentUser)}
            agents={agents}
            team={selectedTeam}
            currentUser={currentUser}
            participation={participationOf(participationByTask, selected.task_id)}
          />
        )}
      </Drawer>
    </div>
  );
}
