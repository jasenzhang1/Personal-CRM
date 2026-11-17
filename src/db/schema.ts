import type { SQLiteDatabase } from './types';

const SCHEMA_VERSION = 3;

/** Runs once when the database opens. Uses PRAGMA user_version for migrations. */
export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        birthday TEXT,            -- 'MM-DD' or 'YYYY-MM-DD'
        photo TEXT,
        company TEXT,
        title TEXT,
        how_met TEXT,
        met_on TEXT,              -- 'YYYY-MM-DD'
        notes TEXT,
        closeness INTEGER NOT NULL DEFAULT 0,   -- 0 = unset, 1..5
        follow_up TEXT NOT NULL DEFAULT 'none', -- see FOLLOW_UPS
        last_contacted TEXT,
        status TEXT NOT NULL DEFAULT 'new',     -- new | backlog | reviewed | archived
        -- professional / pipeline fields
        stage TEXT,               -- null = not in pipeline; see STAGES
        priority TEXT,            -- low | medium | high | critical
        deal_value REAL,
        next_step TEXT,
        next_step_on TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        source TEXT NOT NULL,     -- phone | linkedin | instagram | facebook
        external_id TEXT NOT NULL,
        handle TEXT,
        first_seen TEXT NOT NULL,
        UNIQUE (source, external_id)
      );
      CREATE INDEX IF NOT EXISTS sources_person ON sources(person_id);
      CREATE TABLE IF NOT EXISTS stage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        from_stage TEXT,
        to_stage TEXT,
        note TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stage_events_person ON stage_events(person_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  if (current < 2) {
    await db.execAsync(`
      ALTER TABLE people ADD COLUMN circle TEXT;  -- personal | professional | both; null = guess from sources
      CREATE TABLE IF NOT EXISTS person_tags (
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        tag TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (person_id, tag)
      );
      CREATE INDEX IF NOT EXISTS person_tags_tag ON person_tags(tag);
    `);
  }

  if (current < 3) {
    await db.execAsync(`
      -- Beli-style ranking: one ordered list (pos 0 = closest), split into tiers.
      CREATE TABLE IF NOT EXISTS rankings (
        person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
        tier TEXT NOT NULL,       -- inner | close | casual
        pos INTEGER NOT NULL,
        ranked_at TEXT NOT NULL   -- last time you placed or confirmed them
      );
      -- How much you talk, one row per person per day per source. Only counts are kept, never message text.
      CREATE TABLE IF NOT EXISTS interactions (
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        day TEXT NOT NULL,        -- YYYY-MM-DD
        source TEXT NOT NULL,     -- instagram | facebook | discord | manual
        messages INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        call_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (person_id, day, source)
      );
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
