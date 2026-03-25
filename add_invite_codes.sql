-- Invite code system: create invite_codes table and add founder column to users

CREATE TABLE IF NOT EXISTS invite_codes (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(8) UNIQUE NOT NULL,
  tier            VARCHAR NOT NULL CHECK (tier IN ('just_right', 'turn_it_up', 'after_dark')),
  used            BOOLEAN NOT NULL DEFAULT FALSE,
  used_by_device_id VARCHAR,
  founder         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW(),
  redeemed_at     TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes (code);

ALTER TABLE users ADD COLUMN IF NOT EXISTS founder BOOLEAN DEFAULT FALSE;
