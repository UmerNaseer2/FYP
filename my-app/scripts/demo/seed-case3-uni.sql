-- =============================================================================
-- DEMO CASE 3: UNIVERSITY ENROLLMENT  (uni_v1  vs  uni_v2)
-- =============================================================================
-- What the comparison algorithm will detect:
--   NEW COLUMNS    : professors.office_number
--                    courses.max_capacity
--   NULLABILITY    : students.gpa  nullable → NOT NULL (with DEFAULT)
--   NEW CONSTRAINTS:
--     CHECK  courses.credits BETWEEN 1 AND 6
--     CHECK  students.gpa BETWEEN 0.00 AND 4.00
--     CHECK  enrollments.grade IN allowed values
--     UNIQUE enrollments(student_id, course_id, semester)
--   FK ACTION CHANGE: enrollments.student_id  ON DELETE: NO ACTION → CASCADE
--   NO CHANGES     : departments  (identical in both versions)
--   NO RENAMES     : all 5 tables present in both versions
-- =============================================================================

-- ── Cleanup (safe to re-run) ──────────────────────────────────────────────────
DROP SCHEMA IF EXISTS uni_v1 CASCADE;
DROP SCHEMA IF EXISTS uni_v2 CASCADE;


-- ══════════════════════════════════════════════════════════════════════════════
--  V1  –  original schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA uni_v1;

CREATE TABLE uni_v1.departments (
    id      SERIAL,
    name    VARCHAR(100) NOT NULL,
    code    VARCHAR(10)  NOT NULL,
    faculty VARCHAR(100) NOT NULL,
    CONSTRAINT pk_departments       PRIMARY KEY (id),
    CONSTRAINT uq_departments_name  UNIQUE (name),
    CONSTRAINT uq_departments_code  UNIQUE (code)
);

CREATE TABLE uni_v1.professors (
    id            SERIAL,
    first_name    VARCHAR(100) NOT NULL,
    last_name     VARCHAR(100) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    department_id INTEGER      NOT NULL,
    rank          VARCHAR(50),
    CONSTRAINT pk_professors             PRIMARY KEY (id),
    CONSTRAINT uq_professors_email       UNIQUE (email),
    CONSTRAINT fk_professors_department  FOREIGN KEY (department_id) REFERENCES uni_v1.departments(id)
);

CREATE TABLE uni_v1.courses (
    id            SERIAL,
    code          VARCHAR(20)  NOT NULL,
    title         VARCHAR(255) NOT NULL,
    credits       INTEGER      NOT NULL,
    department_id INTEGER      NOT NULL,
    professor_id  INTEGER,
    CONSTRAINT pk_courses             PRIMARY KEY (id),
    CONSTRAINT uq_courses_code        UNIQUE (code),
    CONSTRAINT fk_courses_department  FOREIGN KEY (department_id) REFERENCES uni_v1.departments(id),
    CONSTRAINT fk_courses_professor   FOREIGN KEY (professor_id)  REFERENCES uni_v1.professors(id)
);

CREATE TABLE uni_v1.students (
    id             SERIAL,
    student_number VARCHAR(20)  NOT NULL,
    first_name     VARCHAR(100) NOT NULL,
    last_name      VARCHAR(100) NOT NULL,
    email          VARCHAR(255) NOT NULL,
    enrolled_at    DATE         NOT NULL DEFAULT CURRENT_DATE,
    gpa            NUMERIC(3,2),                     -- nullable in v1
    CONSTRAINT pk_students               PRIMARY KEY (id),
    CONSTRAINT uq_students_number        UNIQUE (student_number),
    CONSTRAINT uq_students_email         UNIQUE (email)
);

CREATE TABLE uni_v1.enrollments (
    id          SERIAL,
    student_id  INTEGER     NOT NULL,
    course_id   INTEGER     NOT NULL,
    semester    VARCHAR(20) NOT NULL,
    grade       VARCHAR(2),
    enrolled_at DATE        NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT pk_enrollments          PRIMARY KEY (id),
    CONSTRAINT fk_enrollments_student  FOREIGN KEY (student_id) REFERENCES uni_v1.students(id),
    CONSTRAINT fk_enrollments_course   FOREIGN KEY (course_id)  REFERENCES uni_v1.courses(id)
);


-- ══════════════════════════════════════════════════════════════════════════════
--  V2  –  evolved schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA uni_v2;

-- departments: identical — algo should report "no changes"
CREATE TABLE uni_v2.departments (
    id      SERIAL,
    name    VARCHAR(100) NOT NULL,
    code    VARCHAR(10)  NOT NULL,
    faculty VARCHAR(100) NOT NULL,
    CONSTRAINT pk_departments       PRIMARY KEY (id),
    CONSTRAINT uq_departments_name  UNIQUE (name),
    CONSTRAINT uq_departments_code  UNIQUE (code)
);

-- professors: new column office_number
CREATE TABLE uni_v2.professors (
    id            SERIAL,
    first_name    VARCHAR(100) NOT NULL,
    last_name     VARCHAR(100) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    department_id INTEGER      NOT NULL,
    rank          VARCHAR(50),
    office_number VARCHAR(20),                        -- NEW column
    CONSTRAINT pk_professors             PRIMARY KEY (id),
    CONSTRAINT uq_professors_email       UNIQUE (email),
    CONSTRAINT fk_professors_department  FOREIGN KEY (department_id) REFERENCES uni_v2.departments(id)
);

-- courses: new column max_capacity
--          new CHECK: credits must be between 1 and 6
CREATE TABLE uni_v2.courses (
    id            SERIAL,
    code          VARCHAR(20)  NOT NULL,
    title         VARCHAR(255) NOT NULL,
    credits       INTEGER      NOT NULL,
    department_id INTEGER      NOT NULL,
    professor_id  INTEGER,
    max_capacity  INTEGER,                            -- NEW column
    CONSTRAINT pk_courses             PRIMARY KEY (id),
    CONSTRAINT uq_courses_code        UNIQUE (code),
    CONSTRAINT fk_courses_department  FOREIGN KEY (department_id) REFERENCES uni_v2.departments(id),
    CONSTRAINT fk_courses_professor   FOREIGN KEY (professor_id)  REFERENCES uni_v2.professors(id),
    CONSTRAINT chk_courses_credits    CHECK (credits BETWEEN 1 AND 6)   -- NEW constraint
);

-- students: gpa changed from nullable → NOT NULL with DEFAULT
--           new CHECK: gpa range 0.00 – 4.00
CREATE TABLE uni_v2.students (
    id             SERIAL,
    student_number VARCHAR(20)  NOT NULL,
    first_name     VARCHAR(100) NOT NULL,
    last_name      VARCHAR(100) NOT NULL,
    email          VARCHAR(255) NOT NULL,
    enrolled_at    DATE         NOT NULL DEFAULT CURRENT_DATE,
    gpa            NUMERIC(3,2) NOT NULL DEFAULT 0.00,   -- NULLABILITY CHANGED
    CONSTRAINT pk_students               PRIMARY KEY (id),
    CONSTRAINT uq_students_number        UNIQUE (student_number),
    CONSTRAINT uq_students_email         UNIQUE (email),
    CONSTRAINT chk_students_gpa          CHECK (gpa BETWEEN 0.00 AND 4.00)  -- NEW constraint
);

-- enrollments: FK action on student_id changed NO ACTION → CASCADE
--              new UNIQUE constraint on (student_id, course_id, semester)
--              new CHECK on grade values
CREATE TABLE uni_v2.enrollments (
    id          SERIAL,
    student_id  INTEGER     NOT NULL,
    course_id   INTEGER     NOT NULL,
    semester    VARCHAR(20) NOT NULL,
    grade       VARCHAR(2),
    enrolled_at DATE        NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT pk_enrollments           PRIMARY KEY (id),
    CONSTRAINT fk_enrollments_student   FOREIGN KEY (student_id) REFERENCES uni_v2.students(id)
                                            ON DELETE CASCADE,              -- FK ACTION CHANGED
    CONSTRAINT fk_enrollments_course    FOREIGN KEY (course_id)  REFERENCES uni_v2.courses(id),
    CONSTRAINT uq_enrollments_slot      UNIQUE (student_id, course_id, semester),  -- NEW unique
    CONSTRAINT chk_enrollments_grade    CHECK (grade IS NULL OR grade IN ('A','B','C','D','F','W'))  -- NEW check
);


-- ── Verification query ────────────────────────────────────────────────────────
SELECT schemaname, tablename
FROM   pg_tables
WHERE  schemaname IN ('uni_v1', 'uni_v2')
ORDER  BY schemaname, tablename;
