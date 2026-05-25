-- v2.0.0 — Add email verification flag
-- Additive change: new column with safe default, no downtime needed.

ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
