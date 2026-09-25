import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTeams, useTasks } from '@/services';
import {
  useProjects,
  projectRequest,
  projectsChanged,
} from '@/pages/WorkbenchPage/hooks/useProjects';
import { WikiConnections } from '@/pages/OrcaWorkbench/WikiConnections';
import '@/pages/WorkbenchPage/styles/project-board.css';
export function ProjectsPage() {
  const { activeTeamId } = useTeams();
  return activeTeamId ? (
    <Projects key={activeTeamId} team={activeTeamId} />
  ) : (
    <p>Select a team to view projects.</p>
  );
}
function Projects({ team }: { team: string }) {
  const [params, setParams] = useSearchParams();
  const id = params.get('id') || '';
  const { items, assignments, loaded, error } = useProjects(team);
  const project = items.find((p) => p.id === id);
  const { tasks } = useTasks(team, 1, 100);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function save() {
    setBusy(true);
    setFailure('');
    try {
      const result = await projectRequest(team, creating ? 'create' : 'update', {
        id: project?.id,
        name,
        description,
      });
      projectsChanged();
      setEditing(false);
      if (creating && result.id) setParams({ id: result.id });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not save project.');
    } finally {
      setBusy(false);
    }
  }
  const taskIds = new Set(assignments.filter((a) => a.project_id === id).map((a) => a.task));
  return (
    <main className="project-board" style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <header className="project-board-filters">
        <h1>{project ? project.name : 'Projects'}</h1>
        {id && <a href="/#/projects">All projects</a>}
        <button
          disabled={busy}
          onClick={() => {
            setCreating(true);
            setName('');
            setDescription('');
            setEditing(true);
          }}
        >
          New project
        </button>
      </header>
      {(error || failure) && <p role="alert">{error || failure}</p>}
      {!loaded && !error && <p>Loading projects…</p>}
      {editing && (
        <form
          className="project-board-fields"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2>{creating ? 'New project' : 'Edit project'}</h2>
          <label>
            Project name
            <input
              required
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Project context
            <textarea
              maxLength={4000}
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Purpose, audience, constraints and shared background for this project."
            />
          </label>
          <div>
            <button disabled={busy}>Save project</button>{' '}
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!id && (
        <>
          <p>Give each project a home for its context, Wiki connections and tasks.</p>
          {loaded && !items.length && <p>No projects yet. Create your first project above.</p>}
          <ul>
            {items.map((p) => (
              <li key={p.id} style={{ padding: '14px 0' }}>
                <a
                  href={`/#/projects?id=${encodeURIComponent(p.id)}`}
                  onClick={() => setEditing(false)}
                >
                  <strong>{p.name}</strong>
                </a>
                {p.archived ? ' · Archived' : ''}
                <p>{p.description || 'No project context yet.'}</p>
                <small>{assignments.filter((a) => a.project_id === p.id).length} tasks</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {id && loaded && !project && <p>Project not found in this team.</p>}
      {project && (
        <>
          <section className="task-execution">
            <div className="task-execution-heading">
              <h2>Project context</h2>
              {project.canManage && (
                <button
                  onClick={() => {
                    setCreating(false);
                    setName(project.name);
                    setDescription(project.description);
                    setEditing(true);
                  }}
                >
                  Edit project
                </button>
              )}
            </div>
            <p style={{ whiteSpace: 'pre-wrap' }}>
              {project.description || 'Add a description to give workers shared project context.'}
            </p>
            <small>This context is included when you send an assigned task to Orca.</small>
          </section>
          {!project.archived ? (
            <WikiConnections
              key={project.id + project.description}
              team={team}
              kind="project"
              id={project.id}
            />
          ) : (
            <p>This project is archived. Its context is not used for new handoffs.</p>
          )}
          <section className="task-execution">
            <h2>Tasks</h2>
            {!taskIds.size && (
              <p>No tasks assigned. Choose this project in a task’s Project field.</p>
            )}
            <ul>
              {[...taskIds].map((taskId) => (
                <li key={taskId}>
                  <a href={`/#/?task=${encodeURIComponent(taskId)}`}>
                    {tasks.find((t) => t.task_id === taskId)?.title || taskId}
                  </a>
                </li>
              ))}
            </ul>
            <a href="/#/">Open Task Board</a>
          </section>
        </>
      )}
    </main>
  );
}
