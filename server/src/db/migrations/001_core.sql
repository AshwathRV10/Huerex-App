-- ===========================================================================
-- HUEREX GFES v6 · 001 core
-- Identity, RBAC, audit, notifications, master data.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name         TEXT NOT NULL,
  email             TEXT COLLATE NOCASE,
  password_hash     TEXT NOT NULL,
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  must_change_pw    INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_active ON users(is_active);

CREATE TABLE roles (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_system     INTEGER NOT NULL DEFAULT 0,   -- system roles cannot be deleted
  rank          INTEGER NOT NULL DEFAULT 100, -- lower = more privileged
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A grant is a single permission key held by a role.
-- Keys are "<module>.<action>" or "<module>.<field>.<action>" — see rbac/permissions.ts
CREATE TABLE role_permissions (
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  perm_key    TEXT NOT NULL,
  PRIMARY KEY (role_id, perm_key)
);
CREATE INDEX idx_role_permissions_key ON role_permissions(perm_key);

CREATE TABLE user_roles (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Per-user overrides layered on top of role grants. effect: 'allow' | 'deny'.
-- 'deny' always wins, so least privilege can be enforced for one person
-- without inventing a whole role.
CREATE TABLE user_permission_overrides (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm_key    TEXT NOT NULL,
  effect      TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (user_id, perm_key)
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,             -- random 256-bit id, hashed at rest
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  revoked_at    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ------------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL,                -- create | update | delete | login | login_failed | export | approve | ...
  entity        TEXT NOT NULL,                -- table / module name
  entity_id     TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  before_json   TEXT,
  after_json    TEXT,
  ip            TEXT NOT NULL DEFAULT '',
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','notice','warning','critical'))
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_action ON audit_log(action);

-- ----------------------------------------------------------- notifications
CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE, -- null = broadcast to a role
  role_code     TEXT,
  kind          TEXT NOT NULL,                -- approval_pending | approval_decided | alert | recut | shipment_risk | ...
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  link          TEXT NOT NULL DEFAULT '',
  entity        TEXT,
  entity_id     TEXT,
  dedupe_key    TEXT,
  read_at       TEXT,
  dismissed_at  TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at);
CREATE INDEX idx_notif_role ON notifications(role_code, read_at);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);

-- ------------------------------------------------------------ master lists
-- One generic table behind every "type to search, type to add" control.
-- New values written by the UI land here and are instantly searchable.
CREATE TABLE master_values (
  id           INTEGER PRIMARY KEY,
  list_code    TEXT NOT NULL,                 -- buyers | colours | sizes | lines | vendors | fabric_types | trim_items | ...
  value        TEXT NOT NULL,
  sort_order   REAL NOT NULL DEFAULT 1000,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  use_count    INTEGER NOT NULL DEFAULT 0,    -- drives most-used-first ordering
  last_used_at TEXT
);
CREATE UNIQUE INDEX idx_master_unique ON master_values(list_code, value COLLATE NOCASE);
CREATE INDEX idx_master_list ON master_values(list_code, is_active);

-- Buyers carry commercial defaults that change the maths per order.
CREATE TABLE buyers (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  short_code          TEXT NOT NULL DEFAULT '',
  excess_pct          REAL NOT NULL DEFAULT 0,      -- shipped WITH the order qty, buyer-specific
  excess_billable     INTEGER NOT NULL DEFAULT 1,   -- 1 = buyer pays for excess, 0 = we absorb it
  shortfall_tolerance_pct REAL NOT NULL DEFAULT 0,
  default_currency    TEXT NOT NULL DEFAULT 'INR',
  payment_terms       TEXT NOT NULL DEFAULT '',
  contact             TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vendors (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  processes     TEXT NOT NULL DEFAULT '',   -- comma list of processes the vendor does
  contact       TEXT NOT NULL DEFAULT '',
  gst_no        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- app settings
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
