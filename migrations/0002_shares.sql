-- Add only: existing notes, credentials and attachments remain unchanged.
CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS lock_note_shares_insert BEFORE INSERT ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
CREATE TRIGGER IF NOT EXISTS lock_note_shares_update BEFORE UPDATE ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
CREATE TRIGGER IF NOT EXISTS lock_note_shares_delete BEFORE DELETE ON note_shares WHEN (SELECT maintenance FROM app_state WHERE id=1)=1 BEGIN SELECT RAISE(ABORT, 'maintenance'); END;
