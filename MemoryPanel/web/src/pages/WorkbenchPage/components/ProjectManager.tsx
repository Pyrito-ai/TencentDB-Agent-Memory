import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, Plus } from 'lucide-react';
import { Button, Drawer, Modal } from 'tea-component';
import { WikiConnections } from '@/pages/OrcaWorkbench/WikiConnections';
import { projectRequest, projectsChanged, useProjects } from '../hooks/useProjects';
import '../styles/project-manager.css';

interface ProjectManagerProps {
  teamId: string;
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onViewTasks: (id: string) => void;
  onClose: () => void;
}

export function ProjectManager({
  teamId,
  selectedProjectId,
  onSelectProject,
  onViewTasks,
  onClose,
}: ProjectManagerProps) {
  const { items, assignments, loaded, error } = useProjects(teamId);
  const project = items.find((item) => item.id === selectedProjectId);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editorProjectId, setEditorProjectId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const drawerRef = useRef<HTMLDivElement>(null);
  const newProjectRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  const drawerTitle = project?.name || 'Projects';

  useEffect(() => {
    // Tea does not forward aria-label, and the global adapter names drawers only once.
    drawerRef.current?.setAttribute('aria-label', drawerTitle);
  }, [drawerTitle]);

  useEffect(() => {
    const closing = wasEditing.current && !editing;
    wasEditing.current = editing;
    if (!closing) return;
    let secondFrame = 0;
    // Let Tea and the shared dialog adapter finish closing before restoring focus.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const trigger = editorTriggerRef.current;
        const target =
          trigger?.isConnected && trigger.getClientRects().length && !trigger.disabled
            ? trigger
            : newProjectRef.current;
        target?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [editing]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // An unrelated modal above the project manager owns its Escape action.
      if (
        !editing &&
        Array.from(document.querySelectorAll<HTMLElement>('.tea-dialog[role="dialog"]')).some(
          (dialog) => dialog.getClientRects().length > 0,
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (editing) setEditing(false);
      else onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [busy, editing, onClose]);
  const visibleProjects = items.filter(
    (item) =>
      (showArchived || !item.archived) &&
      `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const taskCount = (id: string) =>
    new Set(assignments.filter((assignment) => assignment.project_id === id).map((a) => a.task))
      .size;

  function startNewProject(event: MouseEvent<HTMLButtonElement>) {
    editorTriggerRef.current = event.currentTarget;
    setCreating(true);
    setEditorProjectId(null);
    setName('');
    setDescription('');
    setFailure('');
    setEditing(true);
  }

  function selectProject(id: string | null) {
    setFailure('');
    onSelectProject(id);
  }

  async function save() {
    if (!name.trim() || busy) return;
    const editingProject = items.find((item) => item.id === editorProjectId);
    if (!creating && !editingProject?.canManage) {
      setFailure(
        'This project is no longer available to edit. Close the editor and refresh projects.',
      );
      return;
    }
    setBusy(true);
    setFailure('');
    try {
      const result = await projectRequest(teamId, creating ? 'create' : 'update', {
        id: creating ? undefined : editorProjectId,
        name: name.trim(),
        description,
      });
      projectsChanged();
      setEditing(false);
      if (result.id) onSelectProject(result.id);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not save project.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!project?.canManage || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await projectRequest(teamId, 'archive', { id: project.id, archived: !project.archived });
      projectsChanged();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not update project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Drawer
        ref={drawerRef}
        visible
        size="l"
        className="project-manager-drawer"
        title={drawerTitle}
        subtitle="Project context and the work it belongs to."
        outerClickClosable={!editing && !busy}
        disableCloseIcon={busy}
        onClose={() => {
          if (!busy && !editing) onClose();
        }}
      >
        <div className="project-manager">
          <div className="project-manager-toolbar">
            {selectedProjectId ? (
              <button
                type="button"
                className="project-manager-back"
                disabled={busy}
                onClick={() => selectProject(null)}
              >
                <ArrowLeft size={15} aria-hidden="true" /> All projects
              </button>
            ) : (
              <p>Keep shared context with your tasks.</p>
            )}
            <button
              ref={newProjectRef}
              type="button"
              className="project-manager-primary"
              disabled={busy}
              onClick={startNewProject}
            >
              <Plus size={15} aria-hidden="true" /> New project
            </button>
          </div>

          {(error || (!editing && failure)) && (
            <div className="project-manager-error" role="alert">
              <p>{error || failure}</p>
              {error && (
                <button type="button" onClick={projectsChanged}>
                  Retry projects
                </button>
              )}
            </div>
          )}
          {!loaded && !error && (
            <p className="project-manager-empty" role="status">
              Loading projects…
            </p>
          )}

          {!selectedProjectId && (
            <>
              <div className="project-manager-filters">
                <label className="project-manager-search">
                  Search projects
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a project…"
                  />
                </label>
                <label className="project-manager-check">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                  />
                  Include archived
                </label>
              </div>
              <ul className="project-manager-list" aria-label="Projects">
                {visibleProjects.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="project-manager-row"
                      onClick={() => selectProject(item.id)}
                    >
                      <span className="project-manager-folder">
                        <FolderOpen size={20} aria-hidden="true" />
                      </span>
                      <span className="project-manager-row-copy">
                        <span className="project-manager-row-title">
                          <strong>{item.name}</strong>
                          {!!item.archived && (
                            <span className="project-manager-badge">Archived</span>
                          )}
                        </span>
                        <span className="project-manager-description">
                          {item.description || 'No project context yet.'}
                        </span>
                        <span className="project-manager-count">{taskCount(item.id)} tasks</span>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              {loaded && !error && !visibleProjects.length && (
                <div className="project-manager-empty">
                  <strong>
                    {items.length
                      ? 'No projects match these filters.'
                      : 'Your next project starts here.'}
                  </strong>
                  <p>
                    {items.length
                      ? 'Try a different search or include archived projects.'
                      : 'Create a project to collect its context, Wiki connections, and tasks.'}
                  </p>
                  {!items.length && (
                    <button type="button" onClick={startNewProject}>
                      Create a project
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {selectedProjectId && loaded && !error && !project && (
            <div className="project-manager-empty">
              <p>Project not found in this team.</p>
              <button type="button" onClick={() => selectProject(null)}>
                View all projects
              </button>
            </div>
          )}
          {project && (
            <>
              <section className="project-manager-task-summary" aria-label="Project tasks">
                <div>
                  <strong>{taskCount(project.id)} tasks</strong>
                  {!!project.archived && <span className="project-manager-badge">Archived</span>}
                </div>
                <button type="button" disabled={busy} onClick={() => onViewTasks(project.id)}>
                  View tasks <ArrowRight size={15} aria-hidden="true" />
                </button>
              </section>
              <section className="project-manager-context">
                <header>
                  <h2>Project context</h2>
                  {project.canManage && (
                    <div className="project-manager-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(event) => {
                          editorTriggerRef.current = event.currentTarget;
                          setCreating(false);
                          setEditorProjectId(project.id);
                          setName(project.name);
                          setDescription(project.description);
                          setFailure('');
                          setEditing(true);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" disabled={busy} onClick={() => void toggleArchive()}>
                        {project.archived ? 'Restore' : 'Archive'}
                      </button>
                    </div>
                  )}
                </header>
                <p className="project-manager-context-copy">
                  {project.description ||
                    'Add a description to give workers shared project context.'}
                </p>
                <small>This context accompanies tasks assigned to this project.</small>
              </section>
              {!project.archived ? (
                <WikiConnections
                  key={project.id + project.description}
                  team={teamId}
                  kind="project"
                  id={project.id}
                />
              ) : (
                <p className="project-manager-empty">
                  This project is archived. Its context is not used for new handoffs.
                </p>
              )}
            </>
          )}
        </div>
      </Drawer>
      {editing && (
        <Modal
          visible
          caption={creating ? 'New project' : 'Edit project'}
          size="m"
          disableEscape={busy}
          onClose={() => {
            if (!busy) setEditing(false);
          }}
        >
          <Modal.Body>
            <form
              className="project-manager-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label>
                Project name
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Project context
                <textarea
                  rows={6}
                  maxLength={4000}
                  value={description}
                  disabled={busy}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Purpose, audience, constraints, and shared background."
                />
              </label>
              {failure && (
                <p role="alert" className="project-manager-error">
                  {failure}
                </p>
              )}
            </form>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save project'}
            </Button>
            <Button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  );
}
