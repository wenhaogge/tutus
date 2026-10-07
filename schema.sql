-- Qingji v1. Apply to a NEW database. Timestamps are Unix milliseconds.
-- No upstream schema or API compatibility is required.
-- statement-break
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- statement-break
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- statement-break
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
-- statement-break
CREATE TABLE IF NOT EXISTS auth_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
-- statement-break
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),
  maintenance_token TEXT,
  maintenance_started_at INTEGER
);
-- statement-break
INSERT OR IGNORE INTO app_state(id, maintenance) VALUES(1, 0);
-- statement-break
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
-- statement-break
CREATE INDEX IF NOT EXISTS notes_timeline ON notes(archived_at, pinned DESC, created_at DESC, id);
-- statement-break
-- Capabilities are deliberately excluded from backup manifests.
CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
-- statement-break
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0 AND size <= 10485760),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'deleting')),
  created_at INTEGER NOT NULL
);
-- statement-break
CREATE TABLE IF NOT EXISTS note_attachments (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  PRIMARY KEY (note_id, attachment_id)
);
-- statement-break
CREATE INDEX IF NOT EXISTS attachments_by_note ON note_attachments(attachment_id);
-- statement-break
-- Every business write checks the lock at SQL execution time, including writes
-- already in flight when backup acquires maintenance. Sessions are intentionally
-- excluded so authenticated backup and logout continue to work.
CREATE TRIGGER IF NOT EXISTS lock_owner_insert BEFORE INSERT ON owner WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_owner_update BEFORE UPDATE ON owner WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_owner_delete BEFORE DELETE ON owner WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_notes_insert BEFORE INSERT ON notes WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_notes_update BEFORE UPDATE ON notes WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_notes_delete BEFORE DELETE ON notes WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_shares_insert BEFORE INSERT ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_shares_update BEFORE UPDATE ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_shares_delete BEFORE DELETE ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_attachments_insert BEFORE INSERT ON attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_attachments_update BEFORE UPDATE ON attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_attachments_delete BEFORE DELETE ON attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_attachments_insert BEFORE INSERT ON note_attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_attachments_update BEFORE UPDATE ON note_attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
CREATE TRIGGER IF NOT EXISTS lock_note_attachments_delete BEFORE DELETE ON note_attachments WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
-- statement-break
-- Readiness must be checked in the linking transaction, not only by an earlier
-- API read, because an unreferenced file may be deleted by another request.
CREATE TRIGGER IF NOT EXISTS require_ready_attachment BEFORE INSERT ON note_attachments WHEN (SELECT status FROM attachments WHERE id=NEW.attachment_id) IS NOT 'ready' BEGIN SELECT RAISE(ABORT, 'attachment_unavailable'); END;
