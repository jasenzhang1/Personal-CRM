import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserDb } from './db/browser';
import { migrate } from './db/schema';
import { StoreProvider } from './lib/store';
import { cloud } from './lib/cloud';
import { autoContacts } from './lib/autoContacts';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<div className="boot">Loading…</div>);

BrowserDb.open()
  .then(async (db) => {
    await migrate(db);
    db.lock(); // changes need Edit mode from here on
    void cloud.start(db, () => db.onExternalChange());
    autoContacts.start(db, () => db.onExternalChange());
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
