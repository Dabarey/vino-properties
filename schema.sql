-- vino.properties — D1 Schema
-- Run: wrangler d1 execute vino-db --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS properties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL DEFAULT 'house',
  title         TEXT    NOT NULL DEFAULT '',
  location      TEXT    NOT NULL DEFAULT '',
  province      TEXT    NOT NULL DEFAULT '',
  price         REAL    NOT NULL DEFAULT 0,
  beds          INTEGER NOT NULL DEFAULT 0,
  baths         INTEGER NOT NULL DEFAULT 0,
  area          TEXT    NOT NULL DEFAULT '—',
  land          TEXT    NOT NULL DEFAULT '—',
  land_perches  REAL    NOT NULL DEFAULT 0,
  img           TEXT    NOT NULL DEFAULT 'img-custom',
  amenities     TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  deed          TEXT    NOT NULL DEFAULT 'freehold',
  badge         TEXT,
  badge_key     TEXT,
  description   TEXT    NOT NULL DEFAULT '',
  link          TEXT,
  listing_mode  TEXT    NOT NULL DEFAULT 'buy',
  country       TEXT    NOT NULL DEFAULT 'LK',
  photos        TEXT,                             -- JSON array of URLs
  boosted       INTEGER NOT NULL DEFAULT 0,
  boosted_until TEXT,
  boosted_days  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_country   ON properties(country);
CREATE INDEX IF NOT EXISTS idx_properties_type      ON properties(type);
CREATE INDEX IF NOT EXISTS idx_properties_province  ON properties(province);
CREATE INDEX IF NOT EXISTS idx_properties_boosted   ON properties(boosted);
CREATE INDEX IF NOT EXISTS idx_properties_created   ON properties(created_at DESC);

CREATE TABLE IF NOT EXISTS user_accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT    NOT NULL UNIQUE,
  name       TEXT,
  password   TEXT,
  google_id  TEXT,
  ref_code   TEXT    UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_phone     ON user_accounts(phone);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON user_accounts(google_id);
CREATE INDEX IF NOT EXISTS idx_users_ref_code  ON user_accounts(ref_code);

CREATE TABLE IF NOT EXISTS ad_submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT,
  title            TEXT,
  location         TEXT,
  province         TEXT,
  price            REAL,
  beds             INTEGER,
  baths            INTEGER,
  area             TEXT,
  land             TEXT,
  land_perches     REAL,
  img              TEXT,
  amenities        TEXT,    -- JSON
  deed             TEXT,
  description      TEXT,
  photos           TEXT,    -- JSON array of URLs
  listing_mode     TEXT    DEFAULT 'buy',
  country          TEXT    DEFAULT 'LK',
  status           TEXT    NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
  submitter_name   TEXT,
  submitter_phone  TEXT,
  submitter_email  TEXT,
  package_name     TEXT,
  package_price    TEXT,
  payment_ref      TEXT,
  ref_code         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subs_status   ON ad_submissions(status);
CREATE INDEX IF NOT EXISTS idx_subs_ref_code ON ad_submissions(ref_code);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}'
);

-- Default site settings
INSERT OR IGNORE INTO settings (key, value) VALUES (
  'site_settings',
  '{"wa":"+94752007005","phone":"+94752007005","email":"info@vino.properties","pw":"geetha","adminPhone":"+94752007005"}'
);
