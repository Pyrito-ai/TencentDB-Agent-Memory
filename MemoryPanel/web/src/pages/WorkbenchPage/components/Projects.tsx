import { useState } from 'react';
import { Link } from 'react-router-dom';
import { projectBoardLocation } from '@/constants/navigation';
import { projectRequest, projectsChanged, useProjects } from '../hooks/useProjects';

export function TaskProject({
  teamId,
  taskId,
  canEdit,
}: {
  teamId: string;
  taskId: string;
  canEdit: boolean;
}) {
  const { items, assignments, canAssignAny, error, loaded } = useProjects(teamId);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  const id = assignments.find((a) => a.task === taskId)?.project_id || '';
  async function assign(projectId: string) {
    setBusy(true);
    setFailure('');
    try {
      await projectRequest(teamId, 'assign', { task: taskId, projectId });
      projectsChanged();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Assignment failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-board-fields">
      <label>
        Project
        <select
          aria-label="Task project"
          value={id}
          disabled={!loaded || busy || !(canEdit || canAssignAny)}
          onChange={(e) => void assign(e.target.value)}
        >
          <option value="">Unassigned</option>
          {items
            .filter((p) => !p.archived || p.id === id)
            .map((p) => (
              <option key={p.id} value={p.id} disabled={!!p.archived}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
        </select>
      </label>
      {id && <Link to={projectBoardLocation(id)}>Project details</Link>}
      {(error || failure) && <p role="alert">{error || failure}</p>}
    </section>
  );
}
