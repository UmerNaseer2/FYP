-- Database connection management table
-- Run this in pgAdmin using your postgres database

CREATE TABLE IF NOT EXISTS connections (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database_name TEXT NOT NULL DEFAULT 'postgres',
  type TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  connection_string TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Use this if you already created the old connections table before
ALTER TABLE connections
ADD COLUMN IF NOT EXISTS database_name TEXT NOT NULL DEFAULT 'postgres',
ADD COLUMN IF NOT EXISTS connection_string TEXT;

SELECT * FROM connections;


ALTER TABLE connections
ADD COLUMN IF NOT EXISTS db_location TEXT DEFAULT 'local',
ADD COLUMN IF NOT EXISTS ssl_enabled BOOLEAN DEFAULT false;