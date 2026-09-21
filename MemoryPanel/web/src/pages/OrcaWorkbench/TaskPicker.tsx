import { useEffect, useState } from 'react';
import { tasksApi, type BackendTask } from '@/lib/teamApi';
import { projectRequest, projectsChanged, useProjects } from '../WorkbenchPage/hooks/useProjects';
import { invalidateBackendCache } from '@/stores/backend';

export function TaskPicker({
  team,
  taskId,
  disabled,
  onSelect,
}: {
  team: string;
  taskId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<BackendTask[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const { items: projects } = useProjects(team);
  useEffect(() => {
    let active = true;
    tasksApi
      .list(team)
      .then((items) => {
        if (active) setTasks(items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team]);
  async function create() {
    if (disabled || busy || !title.trim() || !description.trim()) return;
    setBusy(true);
    setError('');
    try {
      const task = await tasksApi.create(team, {
        title: title.trim(),
        description: description.trim(),
        source_type: 'manual',
      });
      // Keep the created task visible even if its optional project assignment fails.
      setTasks((prev) => [task, ...prev]);
      setCreating(false);
      setTitle('');
      setDescription('');
      invalidateBackendCache();
      try {
        if (projectId) {
          await projectRequest(team, 'assign', { task: task.task_id, projectId });
          projectsChanged();
        }
      } finally {
        onSelect(task.task_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create task.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="coordinator-task-picker">
      <label>
        Task Board
        <select
          aria-label="Linked Task Board task"
          value={taskId}
          disabled={disabled || busy}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">Choose a task before launching workers</option>
          {taskId && !tasks.some((item) => item.task_id === taskId) && (
            <option value={taskId}>{taskId}</option>
          )}
          {tasks.map((task) => (
            <option key={task.task_id} value={task.task_id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
      <button disabled={disabled || busy} onClick={() => setCreating(!creating)}>
        New board task
      </button>
      {error && <p role="alert">{error}</p>}
      {creating && (
        <form
          className="task-execution"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Task title
            <input
              value={title}
              required
              maxLength={200}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Objective and acceptance criteria
            <textarea
              value={description}
              required
              maxLength={8000}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Tencent project
            <select
              value={projectId}
              disabled={busy}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Assign later on the board</option>
              {projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <small>
            Creates a Backlog task. Ready status and execution approval are separate steps.
          </small>
          <button disabled={busy || !title.trim() || !description.trim()}>Create board task</button>
        </form>
      )}
    </div>
  );
}
