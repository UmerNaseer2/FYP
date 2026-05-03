-- Script registry setup for the /scripts page.
-- Run this in the database configured by DB_NAME in .env.local.

CREATE TABLE IF NOT EXISTS public.scripts (
  id SERIAL PRIMARY KEY,
  script_name TEXT NOT NULL,
  version TEXT NOT NULL,
  sql_content TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scripts_name_version_unique UNIQUE (script_name, version)
);

CREATE OR REPLACE FUNCTION public.register_script(
  p_script_name TEXT,
  p_version TEXT,
  p_sql_content TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS public.scripts
LANGUAGE plpgsql
AS $$
DECLARE
  new_script public.scripts%ROWTYPE;
BEGIN
  INSERT INTO public.scripts (script_name, version, sql_content, description)
  VALUES (
    btrim(p_script_name),
    btrim(p_version),
    p_sql_content,
    nullif(btrim(coalesce(p_description, '')), '')
  )
  RETURNING * INTO new_script;

  RETURN new_script;
END;
$$;
