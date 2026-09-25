import { useEffect, useState } from 'react';
import { request } from './api';
import './workbench.css';
type ContextPreview = {
  text: string;
  project?: { name: string; description: string } | null;
  excerpts: { ref: string; content: string; truncated: boolean }[];
};
export type WikiRef = { kind: 'wiki_page'; wikiId: string; ref: string };
type Links = {
  revision: number;
  references: WikiRef[];
  inherited: WikiRef[];
  canEdit: boolean;
  project?: { id: string; name: string; description: string } | null;
};
export function WikiConnections({
  team,
  kind,
  id,
}: {
  team: string;
  kind: 'task' | 'project';
  id: string;
}) {
  const [data, setData] = useState<Links>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]);
  const [wiki, setWiki] = useState('');
  const [pages, setPages] = useState<{ path: string; title: string }[]>([]);
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState<ContextPreview>();
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const load = () => {
      const n = ++sequence;
      setData(undefined);
      setPreview(undefined);
      setError('');
      request<Links>(team, 'context-get', { kind, id })
        .then((d) => {
          if (live && n === sequence) setData(d);
        })
        .catch((e) => {
          if (live && n === sequence) setError(e.message);
        });
    };
    load();
    window.addEventListener('projects-changed', load);
    return () => {
      live = false;
      window.removeEventListener('projects-changed', load);
    };
  }, [team, kind, id]);
  useEffect(() => {
    let live = true;
    setPages([]);
    setRef('');
    if (wiki)
      request<{ items: { path: string; title: string }[] }>(team, 'context-pages', { wikiId: wiki })
        .then((d) => {
          if (live) setPages(d.items);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [team, wiki]);
  async function save(references: WikiRef[]) {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      setData(
        await request<Links>(team, 'context-save', {
          kind,
          id,
          revision: data.revision,
          references,
        }),
      );
      setAdding(false);
      setPreview(undefined);
      window.dispatchEvent(new Event('wiki-links-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save links.');
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    setAdding(true);
    setError('');
    try {
      setCatalog(
        (await request<{ items: { id: string; name: string }[] }>(team, 'context-catalog', {}))
          .items,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wiki list unavailable.');
    }
  }
  return (
    <section className="task-execution" aria-label="Wiki connections">
      <div className="task-execution-heading">
        <strong>Wiki connections</strong>
        {data?.canEdit && (
          <button
            type="button"
            disabled={busy || data.references.length >= 8}
            onClick={() => void add()}
          >
            Link Wiki page
          </button>
        )}
      </div>
      <p>
        {kind === 'project'
          ? 'These pages are included when a task in this project is sent to Orca.'
          : 'Project links are inherited. Add pages specific to this task below.'}
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading Wiki links…</p>}
      {data?.project && kind === 'task' && (
        <p>
          Project context:{' '}
          <a href={`/#/projects?id=${encodeURIComponent(data.project.id)}`}>{data.project.name}</a>
          {data.project.description && ` — ${data.project.description}`}
        </p>
      )}
      {data && data.inherited.length > 0 && (
        <div>
          <strong>From project</strong>
          <ul>
            {data.inherited.map((r) => (
              <li key={r.wikiId + r.ref}>
                {r.ref} <small>({r.wikiId})</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data && (
        <>
          <strong>{kind === 'task' ? 'Task links' : 'Project links'}</strong>
          {data.references.length ? (
            <ul>
              {data.references.map((r) => (
                <li key={r.wikiId + r.ref}>
                  {r.ref} <small>({r.wikiId})</small>{' '}
                  {data.canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Unlink ${r.ref}`}
                      onClick={() =>
                        void save(
                          data.references.filter((x) => x.wikiId !== r.wikiId || x.ref !== r.ref),
                        )
                      }
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No pages linked.</p>
          )}
        </>
      )}
      {adding && (
        <div className="project-board-fields">
          <label>
            Wiki
            <select
              aria-label="Wiki to link"
              value={wiki}
              disabled={busy}
              onChange={(e) => setWiki(e.target.value)}
            >
              <option value="">Choose a Wiki</option>
              {catalog.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {!catalog.length && <p>No accessible Wikis in this team.</p>}
          <label>
            Page
            <select
              aria-label="Wiki page to link"
              value={ref}
              disabled={busy || !wiki}
              onChange={(e) => setRef(e.target.value)}
            >
              <option value="">Choose a page</option>
              {pages.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.title || p.path}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              type="button"
              disabled={busy || !wiki || !ref}
              onClick={() =>
                void save([...(data?.references || []), { kind: 'wiki_page', wikiId: wiki, ref }])
              }
            >
              Save link
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {data && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError('');
            void request<ContextPreview>(team, 'context-preview', { kind, id })
              .then(setPreview)
              .catch((e) => setError(e.message));
          }}
        >
          Preview project and Wiki context
        </button>
      )}
      {preview && (
        <details open>
          <summary>Context for the next handoff</summary>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {preview.project && (
              <article>
                <strong>{preview.project.name}</strong>
                <p style={{ whiteSpace: 'pre-wrap' }}>
                  {preview.project.description || 'No project context added yet.'}
                </p>
              </article>
            )}
            {preview.excerpts.map((excerpt, index) => (
              <article key={index}>
                <strong>{excerpt.ref}</strong>
                <p style={{ whiteSpace: 'pre-wrap' }}>{excerpt.content}</p>
              </article>
            ))}
            {!preview.project && !preview.excerpts.length && (
              <p>No project or Wiki context linked.</p>
            )}
          </div>
          {preview.excerpts.some((e) => e.truncated) && (
            <p>Some pages are excerpts: up to 4,000 characters per page and 12,000 total.</p>
          )}
        </details>
      )}
      <small>
        Up to eight distinct pages per handoff. Access is checked again before launch. Changes here
        do not alter an existing handoff.
      </small>
    </section>
  );
}
