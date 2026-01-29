-- Migration: Add member_pairs table for dual-slot pairing support
-- Each user/device can participate in up to TWO independent 1:1 pairings

-- Create member_pairs junction table
CREATE TABLE IF NOT EXISTS member_pairs (
  member_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  last_sent_at INTEGER,
  last_received_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (member_id, slot),
  UNIQUE (member_id, pair_id),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (pair_id) REFERENCES pairs(id) ON DELETE CASCADE
);

-- Index for fast lookup by pair_id
CREATE INDEX IF NOT EXISTS idx_member_pairs_pair_id ON member_pairs(pair_id);

-- Index for fast lookup by member_id
CREATE INDEX IF NOT EXISTS idx_member_pairs_member_id ON member_pairs(member_id);

-- Migrate existing members to member_pairs (slot 1)
-- This preserves existing pairings as slot 1
INSERT OR IGNORE INTO member_pairs (member_id, pair_id, slot, last_sent_at, last_received_at, created_at)
SELECT
  id AS member_id,
  pair_id,
  1 AS slot,
  last_chomp_at AS last_sent_at,
  last_received_at,
  created_at
FROM members
WHERE pair_id IS NOT NULL;
