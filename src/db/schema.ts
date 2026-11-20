import type { SQLiteDatabase } from './types';

const SCHEMA_VERSION = 15;

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
      -- Old tier-based ranking; version 4 below replaces it.
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

  const rankingCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(rankings)');
  if (current < 4 && rankingCols.some((c) => c.name === 'tier')) {
    await db.execAsync(`
      -- No more fixed tiers: each placed person keeps the score you gave them, plus their activity
      -- at that moment so later activity can nudge it. Old tier rankings keep their order, 10 → 1.
      CREATE TABLE rankings_v4 (
        person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
        base REAL NOT NULL,       -- 0–10 score when last placed
        act_at REAL,              -- activity score then (null = measure from the next load)
        ranked_at TEXT NOT NULL
      );
      INSERT INTO rankings_v4 (person_id, base, act_at, ranked_at)
        SELECT person_id,
               ROUND(10 - 9.0 * (ROW_NUMBER() OVER w - 1) / MAX(COUNT(*) OVER () - 1, 1), 1),
               NULL, ranked_at
        FROM rankings
        WINDOW w AS (ORDER BY CASE tier WHEN 'inner' THEN 0 WHEN 'close' THEN 1 ELSE 2 END, pos);
      DROP TABLE rankings;
      ALTER TABLE rankings_v4 RENAME TO rankings;
    `);
  }

  if (current < 5) {
    // The name someone shows in your chats (a good source for their real name).
    await addColumn(db, 'sources', 'display_name', 'TEXT');
    // 1 = you've confirmed this name (renamed it or chose "Keep as is"), so name cleanup leaves it alone.
    await addColumn(db, 'people', 'name_ok', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (current < 6) {
    await db.execAsync(`
      -- Pairs you said are NOT the same person, so duplicate suggestions skip them. a < b.
      CREATE TABLE IF NOT EXISTS not_duplicates (
        a INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        b INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        PRIMARY KEY (a, b)
      );
    `);
  }

  if (current < 7) {
    await db.execAsync(`
      -- Instagram follow status as of your latest export (one row per account, people or not).
      CREATE TABLE IF NOT EXISTS ig_accounts (
        username TEXT PRIMARY KEY,        -- lowercase
        display TEXT,
        follows_me INTEGER NOT NULL DEFAULT 0,
        i_follow INTEGER NOT NULL DEFAULT 0,
        follows_me_since TEXT,            -- YYYY-MM-DD, from Instagram
        i_follow_since TEXT,
        updated_at TEXT
      );
      -- Changes found by comparing exports: followed_me | unfollowed_me | i_followed | i_unfollowed.
      CREATE TABLE IF NOT EXISTS ig_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        at TEXT,                          -- when (for unfollows: the export where they were first missing)
        after TEXT,                       -- the previous export; it happened between after and at
        UNIQUE (username, kind, at)
      );
      CREATE INDEX IF NOT EXISTS ig_events_kind ON ig_events(kind, at);
    `);
  }

  if (current < 8) {
    // Where they live ("Los Angeles, CA"). Filled from phone/Google contact addresses or by you.
    await addColumn(db, 'people', 'city', 'TEXT');
  }

  if (current < 9) {
    // When you last updated or confirmed their picture in a photo round.
    await addColumn(db, 'people', 'photo_checked_at', 'TEXT');
  }

  if (current < 10) {
    // When you connected on that platform (LinkedIn "Connected on", Facebook friends since…).
    await addColumn(db, 'sources', 'connected_on', 'TEXT');
  }

  if (current < 11) {
    await db.execAsync(`
      -- Accounts that changed username/name between exports (see sync/renames.ts).
      CREATE TABLE IF NOT EXISTS account_renames (
        source TEXT NOT NULL,
        old_id TEXT NOT NULL,             -- sources.external_id before
        new_id TEXT NOT NULL,             -- and after
        at TEXT NOT NULL,                 -- export date it was spotted in
        applied INTEGER NOT NULL DEFAULT 0, -- 1 = moved over automatically; 0 = suggested on Duplicates
        PRIMARY KEY (source, old_id, new_id)
      );
    `);
  }

  if (current < 12) {
    // What else they go by: a nickname, or an English name next to a legal/Chinese name ("David" for Wei Zhang).
    await addColumn(db, 'people', 'nickname', 'TEXT');
  }

  if (current < 13) {
    await db.execAsync(`
      -- Every "who are you closer to?" answer, one row per pair (a < b). Answering again replaces it.
      CREATE TABLE IF NOT EXISTS comparisons (
        a INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        b INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        result TEXT NOT NULL,             -- a | b | tie (who is closer)
        at TEXT NOT NULL,
        PRIMARY KEY (a, b)
      );
      CREATE INDEX IF NOT EXISTS comparisons_b ON comparisons(b);
    `);
    // Where someone started before any answers (their activity guess, or an old placement). Scores are refitted from here.
    await addColumn(db, 'rankings', 'prior', 'REAL');
    await db.execAsync('UPDATE rankings SET prior = base WHERE prior IS NULL');
  }

  if (current < 14) {
    await db.execAsync(`
      -- Recycle bin: everyone you deleted in the last 30 days, with everything attached to them (see db/trash.ts).
      CREATE TABLE IF NOT EXISTS trash (
        person_id INTEGER PRIMARY KEY,    -- their old id; restoring puts them back under it
        name TEXT NOT NULL,
        photo TEXT,
        deleted_at TEXT NOT NULL,         -- ISO time
        data TEXT NOT NULL                -- JSON: { table: rows[] }
      );
    `);
  }

  if (current < 15) {
    // The account to open first when someone has several on one network (1 = their main one).
    await addColumn(db, 'sources', 'is_main', 'INTEGER NOT NULL DEFAULT 0');
    await db.execAsync(`
      -- Accounts you removed from someone, so later imports don't put them back.
      CREATE TABLE IF NOT EXISTS removed_sources (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        removed_at TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

async function addColumn(db: SQLiteDatabase, table: string, column: string, def: string) {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
