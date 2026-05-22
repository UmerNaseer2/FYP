-- =====================================================
-- Open pgAdmin
-- Click database test
-- Right-click test
-- Click Query Tool
-- Open/paste your create_test_schemas.sql
-- Click Run / Execute
-- =====================================================


-- =====================================================
-- CREATE TEST SCHEMAS
-- =====================================================

CREATE SCHEMA IF NOT EXISTS ecom_v1;
CREATE SCHEMA IF NOT EXISTS ecom_v2;

CREATE SCHEMA IF NOT EXISTS hr_v1;
CREATE SCHEMA IF NOT EXISTS hr_v2;

CREATE SCHEMA IF NOT EXISTS uni_v1;
CREATE SCHEMA IF NOT EXISTS uni_v2;

-- =====================================================
-- CREATE VERSION TABLES
-- =====================================================

CREATE TABLE IF NOT EXISTS ecom_v1.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ecom_v2.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_v1.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_v2.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uni_v1.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uni_v2.script_patch (
    id SERIAL PRIMARY KEY,
    version VARCHAR(20),
    title VARCHAR(100),
    description TEXT,
    change_type VARCHAR(20),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- INSERT SAMPLE DATA
-- =====================================================

INSERT INTO ecom_v1.script_patch
(version, title, description, change_type)
VALUES
('1.0.0', 'Initial Version', 'Created ecommerce schema', 'breaking'),
('1.1.0', 'Add Product Table', 'Added product features', 'additive');

INSERT INTO ecom_v2.script_patch
(version, title, description, change_type)
VALUES
('2.0.0', 'Major Upgrade', 'New ecommerce redesign', 'breaking');

INSERT INTO hr_v1.script_patch
(version, title, description, change_type)
VALUES
('1.0.0', 'HR Setup', 'Created HR schema', 'additive');

INSERT INTO hr_v2.script_patch
(version, title, description, change_type)
VALUES
('1.2.0', 'HR Update', 'Added employee salary table', 'patch');

INSERT INTO uni_v1.script_patch
(version, title, description, change_type)
VALUES
('1.0.0', 'University Setup', 'Initial university database', 'additive');

INSERT INTO uni_v2.script_patch
(version, title, description, change_type)
VALUES
('2.0.0', 'University Upgrade', 'New enrollment system', 'breaking');

-- =====================================================
-- VERIFY CREATED SCHEMAS
-- =====================================================

SELECT schema_name
FROM information_schema.schemata
WHERE schema_name <> 'information_schema'
AND schema_name NOT LIKE 'pg_%'
ORDER BY schema_name;