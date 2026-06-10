-- v4.0.0 — Enforce email uniqueness
-- Breaking change: will fail if duplicate emails exist in users table.
-- Run a dedup check before applying to production.

ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
CREATE INDEX users_email_idx ON users (email);
