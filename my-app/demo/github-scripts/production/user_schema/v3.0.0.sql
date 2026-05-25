-- v3.0.0 — Role-based access control
-- Additive change: new tables, no existing data touched.

CREATE TABLE roles (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO roles (name) VALUES ('admin'), ('user'), ('moderator');

CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);
