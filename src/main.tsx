import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserDb } from './db/browser';
import { migrate } from './db/schema';
import { StoreProvider } from './lib/store';
import { cloud } from './lib/cloud';
import './styles.css';

// Offline support for the home-screen app (production builds only, so it never caches the dev server).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

const root = createRoot(document.getElementById('root')!);
root.render(<div className="boot">Loading…</div>);

BrowserDb.open()
  .then(async (db) => {
    await migrate(db);
    db.live = true; // every change saves and uploads to GitHub right away, no Edit/Save step
    void cloud.start(db, () => db.onExternalChange());
    root.render(
      <StrictMode>
        <StoreProvider db={db}>
          <App />
        </StoreProvider>
      </StrictMode>,
    );
  })
  .catch((e) => {
    console.error(e);
    root.render(
      <div className="boot">
        Couldn't open your data. If you're in a private/incognito window, try a normal one.
        <pre>{String(e)}</pre>
      </div>,
    );
  });
