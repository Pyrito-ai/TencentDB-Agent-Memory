import { useState } from 'react';
import { useAreas, workApi } from '../hooks/useAreas';
import '../styles/loops.css';
export default function Areas({ teamId, onChanged }: { teamId: string; onChanged?: () => void }) {
  const areas = useAreas(teamId),
    [form, setForm] = useState({ id: '', name: '', description: '' }),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(action: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await workApi(`areas/${encodeURIComponent(teamId)}/${action}`, body);
      areas.reload();
      onChanged?.();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save Area.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="loops-view">
      <header>
        <div>
          <h2>Areas</h2>
          <p>Ongoing bodies of work for this team. Give recurring responsibilities a home.</p>
        </div>
        <button
          onClick={() => {
            setForm({ id: '', name: '', description: '' });
            setEditing(true);
          }}
        >
          New Area
        </button>
      </header>
      {(error || areas.error) && <p role="alert">{error || areas.error}</p>}
      {editing && (
        <form
          className="loop-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(form.id ? 'update' : 'create', form);
          }}
        >
          <label>
            Area name
            <input
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={4000}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <div className="loop-inline">
            <button disabled={busy}>Save Area</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!areas.loaded && !areas.error && <p role="status">Loading Areas…</p>}
      <div className="loop-cards">
        {areas.items.map((a) => (
          <article key={a.id}>
            <h3>
              {a.name}
              {!!a.archived && ' · Archived'}
            </h3>
            <p>{a.description || 'No description yet.'}</p>
            {a.canManage && (
              <div className="loop-inline">
                <button
                  disabled={busy}
                  onClick={() => {
                    setForm({ id: a.id, name: a.name, description: a.description });
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  disabled={busy}
                  onClick={() => void save('archive', { id: a.id, archived: !a.archived })}
                >
                  {a.archived ? 'Restore' : 'Archive'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {areas.loaded && !areas.items.length && (
        <p>Create an Area such as Paid advertising, Email marketing, or Social media.</p>
      )}
    </section>
  );
}
