-- =============================================================================
-- DEMO CASE 2: HR SYSTEM  (hr_v1  vs  hr_v2)
-- =============================================================================
-- What the comparison algorithm will detect:
--   COLUMN RENAMES : employees.email → work_email
--                    employees.salary → base_salary
--                    roles.level → grade
--   NEW COLUMNS    : employee_roles.end_date
--   NEW CONSTRAINT : CHECK (base_salary > 0) on employees
--   DROPPED TABLE  : leave_requests  (only in v1)
--   NEW TABLE      : time_off  (only in v2 — algo may flag as possible rename
--                    of leave_requests due to shared FK + date columns)
--   NO CHANGES     : departments  (identical in both versions)
-- =============================================================================

-- ── Cleanup (safe to re-run) ──────────────────────────────────────────────────
DROP SCHEMA IF EXISTS hr_v1 CASCADE;
DROP SCHEMA IF EXISTS hr_v2 CASCADE;


-- ══════════════════════════════════════════════════════════════════════════════
--  V1  –  original schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA hr_v1;

CREATE TABLE hr_v1.departments (
    id       SERIAL,
    name     VARCHAR(100)  NOT NULL,
    location VARCHAR(255),
    budget   NUMERIC(15,2),
    CONSTRAINT pk_departments      PRIMARY KEY (id),
    CONSTRAINT uq_departments_name UNIQUE (name)
);

CREATE TABLE hr_v1.employees (
    id            SERIAL,
    first_name    VARCHAR(100)  NOT NULL,
    last_name     VARCHAR(100)  NOT NULL,
    email         VARCHAR(255)  NOT NULL,
    hire_date     DATE          NOT NULL,
    department_id INTEGER,
    salary        NUMERIC(10,2) NOT NULL,
    manager_id    INTEGER,
    CONSTRAINT pk_employees             PRIMARY KEY (id),
    CONSTRAINT uq_employees_email       UNIQUE (email),
    CONSTRAINT fk_employees_department  FOREIGN KEY (department_id) REFERENCES hr_v1.departments(id),
    CONSTRAINT fk_employees_manager     FOREIGN KEY (manager_id)    REFERENCES hr_v1.employees(id)
);

CREATE TABLE hr_v1.roles (
    id         SERIAL,
    title      VARCHAR(100)  NOT NULL,
    level      INTEGER       NOT NULL,
    min_salary NUMERIC(10,2) NOT NULL,
    max_salary NUMERIC(10,2) NOT NULL,
    CONSTRAINT pk_roles PRIMARY KEY (id)
);

CREATE TABLE hr_v1.employee_roles (
    id          SERIAL,
    employee_id INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    assigned_at DATE    NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT pk_employee_roles          PRIMARY KEY (id),
    CONSTRAINT fk_employee_roles_employee FOREIGN KEY (employee_id) REFERENCES hr_v1.employees(id),
    CONSTRAINT fk_employee_roles_role     FOREIGN KEY (role_id)     REFERENCES hr_v1.roles(id)
);

CREATE TABLE hr_v1.leave_requests (
    id          SERIAL,
    employee_id INTEGER     NOT NULL,
    leave_type  VARCHAR(50) NOT NULL,
    start_date  DATE        NOT NULL,
    end_date    DATE        NOT NULL,
    approved    BOOLEAN,
    CONSTRAINT pk_leave_requests          PRIMARY KEY (id),
    CONSTRAINT fk_leave_requests_employee FOREIGN KEY (employee_id) REFERENCES hr_v1.employees(id)
);


-- ══════════════════════════════════════════════════════════════════════════════
--  V2  –  evolved schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA hr_v2;

-- departments: identical — algo should report "no changes"
CREATE TABLE hr_v2.departments (
    id       SERIAL,
    name     VARCHAR(100)  NOT NULL,
    location VARCHAR(255),
    budget   NUMERIC(15,2),
    CONSTRAINT pk_departments      PRIMARY KEY (id),
    CONSTRAINT uq_departments_name UNIQUE (name)
);

-- employees: email → work_email (column renamed)
--            salary → base_salary (column renamed)
--            + CHECK constraint: base_salary must be positive
CREATE TABLE hr_v2.employees (
    id            SERIAL,
    first_name    VARCHAR(100)  NOT NULL,
    last_name     VARCHAR(100)  NOT NULL,
    work_email    VARCHAR(255)  NOT NULL,            -- RENAMED from email
    hire_date     DATE          NOT NULL,
    department_id INTEGER,
    base_salary   NUMERIC(10,2) NOT NULL,            -- RENAMED from salary
    manager_id    INTEGER,
    CONSTRAINT pk_employees                  PRIMARY KEY (id),
    CONSTRAINT uq_employees_work_email       UNIQUE (work_email),
    CONSTRAINT fk_employees_department       FOREIGN KEY (department_id) REFERENCES hr_v2.departments(id),
    CONSTRAINT fk_employees_manager          FOREIGN KEY (manager_id)    REFERENCES hr_v2.employees(id),
    CONSTRAINT chk_employees_base_salary     CHECK (base_salary > 0)     -- NEW constraint
);

-- roles: level → grade (column renamed)
CREATE TABLE hr_v2.roles (
    id         SERIAL,
    title      VARCHAR(100)  NOT NULL,
    grade      INTEGER       NOT NULL,               -- RENAMED from level
    min_salary NUMERIC(10,2) NOT NULL,
    max_salary NUMERIC(10,2) NOT NULL,
    CONSTRAINT pk_roles PRIMARY KEY (id)
);

-- employee_roles: new column end_date added
CREATE TABLE hr_v2.employee_roles (
    id          SERIAL,
    employee_id INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    assigned_at DATE    NOT NULL DEFAULT CURRENT_DATE,
    end_date    DATE,                                -- NEW column
    CONSTRAINT pk_employee_roles          PRIMARY KEY (id),
    CONSTRAINT fk_employee_roles_employee FOREIGN KEY (employee_id) REFERENCES hr_v2.employees(id),
    CONSTRAINT fk_employee_roles_role     FOREIGN KEY (role_id)     REFERENCES hr_v2.roles(id)
);

-- leave_requests is GONE in v2  (algo will report: only in v1)

-- time_off: new table in v2.
-- Structurally similar to leave_requests (same FK to employees, same date columns)
-- so the algo may flag it as a possible rename candidate.
CREATE TABLE hr_v2.time_off (
    id           SERIAL,
    employee_id  INTEGER     NOT NULL,
    request_type VARCHAR(50) NOT NULL,               -- was leave_type
    start_date   DATE        NOT NULL,
    end_date     DATE        NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- was approved (boolean)
    CONSTRAINT pk_time_off          PRIMARY KEY (id),
    CONSTRAINT fk_time_off_employee FOREIGN KEY (employee_id) REFERENCES hr_v2.employees(id),
    CONSTRAINT chk_time_off_status  CHECK (status IN ('pending', 'approved', 'rejected'))
);


-- ── Verification query ────────────────────────────────────────────────────────
SELECT schemaname, tablename
FROM   pg_tables
WHERE  schemaname IN ('hr_v1', 'hr_v2')
ORDER  BY schemaname, tablename;
