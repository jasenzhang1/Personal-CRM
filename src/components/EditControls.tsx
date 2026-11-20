import { useStore } from '@/lib/store';

/** Turn Edit mode on, or save/discard the changes made while it's on. Scrolls with the page. */
export function EditControls() {
  const { db, editing, hasEdits, beginEdit, saveEdit, discardEdit } = useStore();
  if (db.live) return null; // live mode: changes save on their own
  return (
    <section className={`card edit-bar${editing ? ' on' : ''}`} aria-label="Edit mode">
      {editing ? (
        <>
          <span className="grow small">
            <strong>Editing.</strong> {hasEdits ? 'Your changes aren’t saved until you press Save.' : 'Make your changes, then press Save.'}
          </span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              if (hasEdits && !confirm('Throw away every change since you turned on Edit mode?')) return;
              discardEdit();
            }}
          >
            {hasEdits ? 'Discard' : 'Cancel'}
          </button>
          <button type="button" className="btn primary small" onClick={() => void saveEdit()}>
            Save
          </button>
        </>
      ) : (
        <>
          <span className="grow small muted">View only</span>
          <button type="button" className="btn secondary small" onClick={beginEdit}>
            ✎ Edit
          </button>
        </>
      )}
    </section>
  );
}
