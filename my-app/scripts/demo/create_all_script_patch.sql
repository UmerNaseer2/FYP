-- 1. Create schemas first
CREATE SCHEMA IF NOT EXISTS ecom_v1;
CREATE SCHEMA IF NOT EXISTS ecom_v2;
CREATE SCHEMA IF NOT EXISTS hr_v1;
CREATE SCHEMA IF NOT EXISTS hr_v2;
CREATE SCHEMA IF NOT EXISTS uni_v1;
CREATE SCHEMA IF NOT EXISTS uni_v2;

-- 2. Create script_patch table in every schema
DO $$
DECLARE
    s TEXT;
BEGIN
    FOREACH s IN ARRAY ARRAY[
        'ecom_v1',
        'ecom_v2',
        'hr_v1',
        'hr_v2',
        'uni_v1',
        'uni_v2'
    ]
    LOOP
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.script_patch (
                id SERIAL PRIMARY KEY,
                version VARCHAR(20) NOT NULL,
                title VARCHAR(150),
                description TEXT,
                change_type VARCHAR(20) NOT NULL CHECK (
                    change_type IN (''breaking'', ''additive'', ''patch'', ''unknown'')
                ),
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        ', s);

        EXECUTE format('TRUNCATE TABLE %I.script_patch RESTART IDENTITY;', s);
    END LOOP;
END $$;

-- 3. Insert version data

INSERT INTO ecom_v1.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial schema', 'Created base e-commerce tables.', 'breaking', '2026-04-01 09:00:00'),
('1.1.0', 'Add email changes', 'Added email-related schema changes.', 'additive', '2026-04-05 09:00:00'),
('1.1.1', 'Small constraint fix', 'Small constraint fix.', 'patch', '2026-04-08 09:00:00');

INSERT INTO ecom_v2.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial schema', 'Created base e-commerce tables.', 'breaking', '2026-04-01 09:00:00'),
('1.1.0', 'Add email changes', 'Added email-related schema changes.', 'additive', '2026-04-05 09:00:00'),
('1.2.0', 'Add order status', 'Added new order/status changes.', 'additive', '2026-04-10 09:00:00');

INSERT INTO hr_v1.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial HR schema', 'Created base HR tables.', 'breaking', '2026-04-01 09:00:00'),
('1.1.0', 'Add employee role data', 'Added employee role mapping.', 'additive', '2026-04-05 09:00:00');

INSERT INTO hr_v2.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial HR schema', 'Created base HR tables.', 'breaking', '2026-04-01 09:00:00'),
('1.1.0', 'Add employee role data', 'Added employee role mapping.', 'additive', '2026-04-05 09:00:00'),
('2.0.0', 'HR restructure', 'Renamed salary and leave request structures.', 'breaking', '2026-04-12 09:00:00');

INSERT INTO uni_v1.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial university schema', 'Created university enrollment tables.', 'breaking', '2026-04-01 09:00:00');

INSERT INTO uni_v2.script_patch 
(version, title, description, change_type, applied_at) VALUES
('1.0.0', 'Initial university schema', 'Created university enrollment tables.', 'breaking', '2026-04-01 09:00:00'),
('1.1.0', 'Add constraints', 'Added GPA, course capacity, and enrollment constraints.', 'additive', '2026-04-09 09:00:00');

-- 4. Check result
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name = 'script_patch'
ORDER BY table_schema;

SELECT * FROM ecom_v1.script_patch;
SELECT * FROM ecom_v2.script_patch;