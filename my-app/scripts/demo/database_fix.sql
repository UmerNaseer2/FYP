-- =====================================================
-- PostgreSQL Database Fix SQL
-- =====================================================

-- 1. Check Existing Databases
SELECT datname FROM pg_database;

-- =====================================================
-- 2. Create Database (Recommended)
-- =====================================================
CREATE DATABASE "Test";

-- OR

-- CREATE DATABASE ecom_db;

-- =====================================================
-- 3. Fix Wrong Saved Database Name
-- =====================================================

UPDATE connections
SET database_name = 'test'
WHERE database_name = 'Test';

SELECT * FROM connections;

-- OR

-- UPDATE connections
-- SET database_name = 'postgres'
-- WHERE database_name = 'Test';

-- =====================================================
-- 4. Verify Saved Connections
-- =====================================================

CREATE DATABASE test;

-- =====================================================
-- Notes
-- =====================================================

-- Connection Name = display name only
-- Database Name = actual PostgreSQL database
-- Different connection names can still connect
-- to the same database if database_name is same
