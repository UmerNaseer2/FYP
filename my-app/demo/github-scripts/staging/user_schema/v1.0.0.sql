-- v1.0.0 — Initial user schema
-- Creates the core users and profiles tables.

CREATE TABLE users (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(100) NOT NULL UNIQUE,
    email      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name  VARCHAR(200),
    bio        TEXT,
    avatar_url TEXT
);
