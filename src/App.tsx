import { createHashRouter, NavLink, Outlet, RouterProvider, ScrollRestoration } from 'react-router';
import { useStore } from './lib/store';
import { cloud, useCloud } from './lib/cloud';
import { Inbox } from './pages/Inbox';
import { People } from './pages/People';
import { PersonPage } from './pages/Person';
import { Pipeline } from './pages/Pipeline';
import { Rank } from './pages/Rank';
import { Names } from './pages/Names';
import { Duplicates } from './pages/Duplicates';
import { Followers } from './pages/Followers';
import { Birthdays } from './pages/Birthdays';
import { PhotoRound } from './pages/PhotoRound';
import { Timeline } from './pages/Timeline';
import { Reminders } from './pages/Reminders';
import { Sync } from './pages/Sync';

function Layout() {
  const { inboxCount, proMode, saveError, editing, hasEdits, beginEdit, saveEdit, discardEdit, blocked, dismissBlocked } = useStore();
  const sync = useCloud();
  const links = [
    { to: '/', label: 'Inbox', icon: '📥', badge: inboxCount },
    { to: '/people', label: 'People', icon: '👥' },
    { to: '/timeline', label: 'Timeline', icon: '🗓' },
    { to: '/rank', label: 'Rank', icon: '🏆' },
    { to: '/reminders', label: 'Reminders', icon: '⏰' },
    ...(proMode ? [{ to: '/pipeline', label: 'Pipeline', icon: '📊' }] : []),
    { to: '/sync', label: 'Import & settings', short: 'Import', icon: '🔄' },
  ];
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark">◉</span> Personal CRM
        </div>
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === '/'} className="nav-link">
            <span className="nav-icon">{l.icon}</span>
            <span className="nav-label">{l.label}</span>
            {!!l.badge && <span className="badge">{l.badge}</span>}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <div className={`edit-bar${editing ? ' on' : ''}`} role="region" aria-label="Edit mode">
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
        </div>
        {saveError && (
          <p className="notice err save-error" role="alert">
            ⚠ This browser refused to save your latest changes ({saveError}). They're kept while this tab stays open. Download a backup from
            Import & settings, and check you're not in a private window.
          </p>
        )}
        {sync.status === 'signin' && (
          <p className="notice cloud-notice row-gap">
            <span className="grow">
              ☁ {sync.pending ? 'You have changes that aren’t in Google Drive yet.' : 'Sign in to get your latest data from Google Drive.'}
            </span>
            <button className="btn primary small" onClick={() => void cloud.sync(true)}>
              Sync now
            </button>
          </p>
        )}
        {sync.status === 'error' && sync.error && (
          <p className="notice err cloud-notice row-gap">
            <span className="grow">☁ Google Drive sync: {sync.error}</span>
            <button className="btn danger small" onClick={() => void cloud.sync(true)}>
              Try again
            </button>
          </p>
        )}
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === '/'} className="tab-link">
            <span className="tab-icon">
              {l.icon}
              {!!l.badge && <span className="badge badge-dot">{l.badge}</span>}
            </span>
            <span>{l.short ?? l.label}</span>
          </NavLink>
        ))}
      </nav>
      {blocked && !editing && (
        <div className="edit-toast" role="alert">
          <span className="grow">Edit mode is off, so that change wasn’t made.</span>
          <button type="button" className="btn primary small" onClick={beginEdit}>
            Turn on Edit mode
          </button>
          <button type="button" className="btn ghost small" onClick={dismissBlocked} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <ScrollRestoration />
    </div>
  );
}

// Hash routing so the built site works on any static host without server rewrites.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Inbox /> },
      { path: '/people', element: <People /> },
      { path: '/rank', element: <Rank /> },
      { path: '/names', element: <Names /> },
      { path: '/duplicates', element: <Duplicates /> },
      { path: '/followers', element: <Followers /> },
      { path: '/birthdays', element: <Birthdays /> },
      { path: '/photos', element: <PhotoRound /> },
      { path: '/timeline', element: <Timeline /> },
      { path: '/reminders', element: <Reminders /> },
      { path: '/pipeline', element: <Pipeline /> },
      { path: '/sync', element: <Sync /> },
      { path: '/person/:id', element: <PersonPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
