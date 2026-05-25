-- =============================================================================
-- DEMO SETUP SCRIPT
-- Run this in pgAdmin (or psql) against your target database BEFORE demoing.
--
-- What it creates:
--   staging    schema — at v1.0.0 (3 scripts pending in app)
--   production schema — at v4.0.0 (fully up to date, 0 pending)
--
-- GitHub side (do this first via the app's "Push to GitHub" form):
--   Push the 4 SQL files from demo/github-scripts/staging/user_schema/  to GitHub
--   Push the 4 SQL files from demo/github-scripts/production/user_schema/ to GitHub
--   (or copy via the GitHub web UI — same content, just different schema folder)
-- =============================================================================

-- ─── Create schemas ───────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS production;


-- =============================================================================
--  STAGING  —  at v1.0.0
--  Only the initial tables exist. v2, v3, v4 are pending.
-- =============================================================================

-- Tables at v1.0.0 state
CREATE TABLE staging.users (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(100) NOT NULL UNIQUE,
    email      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE staging.profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES staging.users(id) ON DELETE CASCADE,
    full_name  VARCHAR(200),
    bio        TEXT,
    avatar_url TEXT
);

-- Sample rows
INSERT INTO staging.users (username, email) VALUES
    ('alice', 'alice@example.com'),
    ('bob',   'bob@example.com');

INSERT INTO staging.profiles (user_id, full_name, bio) VALUES
    (1, 'Alice Chen',  'Frontend engineer at Acme'),
    (2, 'Bob Smith',   'Backend developer at Acme');

-- Audit table (same structure the app creates automatically on first deploy)
CREATE TABLE staging.script_patch (
    id          SERIAL PRIMARY KEY,
    script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
    version     VARCHAR(20)  NOT NULL,
    title       VARCHAR(150),
    description TEXT,
    change_type VARCHAR(20)  NOT NULL
                  CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX staging_sp_name_ver_idx ON staging.script_patch (script_name, version);

-- Only v1.0.0 has been applied
INSERT INTO staging.script_patch (script_name, version, title, description, change_type, applied_at) VALUES
    ('user_schema', '1.0.0', 'Initial schema', 'Create users and profiles tables', 'additive', '2025-03-01 09:00:00');


-- =============================================================================
--  PRODUCTION  —  at v4.0.0
--  All 4 migrations applied. Fully up to date.
-- =============================================================================

-- Tables at v4.0.0 state (includes every column/table added by all 4 migrations)
CREATE TABLE production.users (
    id             SERIAL PRIMARY KEY,
    username       VARCHAR(100) NOT NULL UNIQUE,
    email          VARCHAR(255) NOT NULL,
    email_verified BOOLEAN      NOT NULL DEFAULT false,       -- added in v2.0.0
    created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT production_users_email_unique UNIQUE (email)  -- added in v4.0.0
);
CREATE INDEX production_users_email_idx ON production.users (email);  -- added in v4.0.0

CREATE TABLE production.profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES production.users(id) ON DELETE CASCADE,
    full_name  VARCHAR(200),
    bio        TEXT,
    avatar_url TEXT
);

CREATE TABLE production.roles (        -- added in v3.0.0
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE production.user_roles (   -- added in v3.0.0
    user_id INTEGER NOT NULL REFERENCES production.users(id)  ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES production.roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Sample rows
INSERT INTO production.roles (name) VALUES ('admin'), ('user'), ('moderator');

INSERT INTO production.users (username, email, email_verified) VALUES
    ('alice', 'alice@example.com', true),
    ('bob',   'bob@example.com',   true),
    ('carol', 'carol@example.com', false);

INSERT INTO production.profiles (user_id, full_name, bio) VALUES
    (1, 'Alice Chen',  'Frontend engineer'),
    (2, 'Bob Smith',   'Backend developer'),
    (3, 'Carol White', 'QA engineer');

INSERT INTO production.user_roles (user_id, role_id) VALUES (1, 1), (2, 2), (3, 2);

-- Audit table
CREATE TABLE production.script_patch (
    id          SERIAL PRIMARY KEY,
    script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
    version     VARCHAR(20)  NOT NULL,
    title       VARCHAR(150),
    description TEXT,
    change_type VARCHAR(20)  NOT NULL
                  CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX production_sp_name_ver_idx ON production.script_patch (script_name, version);

-- All 4 versions applied
INSERT INTO production.script_patch (script_name, version, title, description, change_type, applied_at) VALUES
    ('user_schema', '1.0.0', 'Initial schema',          'Create users and profiles tables',        'additive', '2025-03-01 09:00:00'),
    ('user_schema', '2.0.0', 'Email verification',      'Add email_verified column to users',      'additive', '2025-03-15 14:30:00'),
    ('user_schema', '3.0.0', 'Role-based access',       'Add roles and user_roles tables',         'additive', '2025-04-01 11:00:00'),
    ('user_schema', '4.0.0', 'Enforce email uniqueness','Add UNIQUE constraint on users.email',    'breaking', '2025-04-20 16:45:00');
