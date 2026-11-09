-- D1 schema for shani-shvilin-stats. Safe to run again: everything is IF NOT EXISTS.
-- npx wrangler d1 execute shani-shvilin-stats --remote --file=schema.sql

-- One row per day, file and source, counted up.
CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,          -- UTC, YYYY-MM-DD
  kind TEXT NOT NULL,         -- apk | installer
  channel TEXT NOT NULL,      -- stable | beta | '' for the installer
  abi TEXT NOT NULL,          -- arm64-v8a, armeabi-v7a, ... | ''
  source TEXT NOT NULL,       -- site | installer | update
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, channel, abi, source)
);

-- One row per installation that sent X-Install-Id. id is a salted hash of it.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,   -- ISO timestamp, UTC
  last_seen TEXT NOT NULL,
  version TEXT,
  channel TEXT,
  sdk INTEGER,
  checks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_last_seen ON devices (last_seen);
CREATE INDEX IF NOT EXISTS devices_first_seen ON devices (first_seen);

-- Update checks per day, background (daily worker) or manual (the button).
CREATE TABLE IF NOT EXISTS checks (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  background INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel, background)
);

-- Checks from versions that send no id: one row per hashed address and user
-- agent per day. An estimate, kept apart from devices.
CREATE TABLE IF NOT EXISTS legacy_checks (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (day, key)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
