import { useState } from 'react';
import { Layers3, Plus } from 'lucide-react';
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
    <section className="loops-view areas-view">
      <header className="work-page-header">
        <div>
          <span className="work-eyebrow">A home for your work</span>
          <h2>Areas</h2>
          <p>Ongoing bodies of work for this team. Give recurring responsibilities a home.</p>
        </div>
        <button
          className="work-primary"
          onClick={() => {
            setForm({ id: '', name: '', description: '' });
            setEditing(true);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          New Area
        </button>
      </header>
      {(error || areas.error) && (
        <p className="work-empty" role="alert">
          {error || areas.error}
        </p>
      )}
      {editing && (
        <form
          className="loop-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(form.id ? 'update' : 'create', form);
          }}
        >
          <div className="loop-section-heading">
            <span className="work-eyebrow">Area details</span>
            <h3>{form.id ? 'Edit Area' : 'Create an Area'}</h3>
          </div>
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
            <button className="work-primary" disabled={busy}>
              Save Area
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!areas.loaded && !areas.error && (
        <p className="work-empty" role="status">
          Loading Areas…
        </p>
      )}
      <div className="loop-cards area-cards">
        {areas.items.map((a) => (
          <article
            className={`work-surface area-card${a.archived ? ' is-archived' : ''}`}
            key={a.id}
          >
            <div className="loop-card-kicker">
              <Layers3 size={18} aria-hidden="true" />
              <span className="loop-state-badge">{a.archived ? 'Archived' : 'Area'}</span>
            </div>
            <h3>{a.name}</h3>
            <p className="area-card-description">{a.description || 'No description yet.'}</p>
            {a.canManage && (
              <div className="loop-inline area-card-actions">
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
        <div className="work-empty">
          <Layers3 size={24} aria-hidden="true" />
          <h3>Give ongoing work a home</h3>
          <p>Create an Area such as Paid advertising, Email marketing, or Social media.</p>
        </div>
      )}
    </section>
  );
}
