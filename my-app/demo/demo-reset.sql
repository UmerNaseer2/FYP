-- =============================================================================
-- DEMO RESET SCRIPT
-- Run this in pgAdmin after a demo run to wipe everything and start fresh.
-- Then re-run demo-setup.sql to restore the two-schema demo state.
-- =============================================================================

DROP SCHEMA IF EXISTS staging    CASCADE;
DROP SCHEMA IF EXISTS production CASCADE;
