import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BrowserDb } from '@/db/browser';
import { countByStatus, getSetting, setSetting } from '@/db/people';

interface Store {
  db: BrowserDb;
  /** Increments after every write; queries re-run when it changes. */
  version: number;
  bump: () => void;
  inboxCount: number;
  proMode: boolean;
  setProMode: (on: boolean) => Promise<void>;
  /** Set when the browser refused to save; cleared on the next successful save. */
  saveError: string | null;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ db, children }: { db: BrowserDb; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const [proMode, setProModeState] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    db.onExternalChange = bump; // another tab saved changes
    db.onSaveError = (e) => setSaveError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    db.onSaved = () => setSaveError(null);
  }, [db, bump]);

  useEffect(() => {
    countByStatus(db, 'new').then(setInboxCount);
    getSetting(db, 'pro_mode').then((v) => setProModeState(v === '1'));
  }, [db, version]);

  const setProMode = useCallback(
    async (on: boolean) => {
      await setSetting(db, 'pro_mode', on ? '1' : '0');
      setProModeState(on);
      bump();
    },
    [db, bump],
  );

  return <Ctx.Provider value={{ db, version, bump, inboxCount, proMode, setProMode, saveError }}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside StoreProvider');
  return s;
}

/** Run a DB query; re-runs whenever data changes or a dependency changes. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const { version } = useStore();
  const [data, setData] = useState<T>();
  useEffect(() => {
    let alive = true;
    fn().then((d) => alive && setData(d)).catch(console.error);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return data;
}
