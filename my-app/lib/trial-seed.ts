// The trial's demo data: five small schemas in the one trial database, so
// Compare, Deploy, Version Sync, Drift and the rest have real differences to
// show.
//
//   students_prod, students_staging, students_dev
//       One student-records app at three stages, each with the app's own
//       script ledger (script_patch), the same table a deploy writes. Prod has
//       script 1.0.0 applied, staging is one script ahead (1.1.0), and dev is
//       two ahead (1.2.0), so Version Sync can bring prod or staging up to dev.
//
//   courses_staging, courses_dev
//       Degrees and the courses in them, with no script ledger at all, so
//       Compare works from the tables alone. Each has something the other
//       does not.
//
// Pure: the SQL only, which lib/trial-sandbox.ts runs in one transaction.

/** One script in the student-records app's history, as a deploy records it. */
export type StudentScript = {
  version: string;
  title: string;
  description: string;
  changeType: "additive" | "breaking" | "patch";
  /** Unqualified, as a deploy runs it: search_path picks the schema. */
  up: string;
  down: string;
};

/** The student-records app's scripts, oldest first. */
export const STUDENT_SCRIPTS: readonly StudentScript[] = [
  {
    version: "1.0.0",
    title: "Students, units and enrolments",
    description: "The first tables: who studies here, what they can take, and what they took.",
    changeType: "additive",
    up: `CREATE TABLE students (
  id serial PRIMARY KEY,
  student_number varchar(10) NOT NULL UNIQUE,
  full_name varchar(100) NOT NULL,
  email varchar(100) NOT NULL UNIQUE,
  enrolled_on date NOT NULL
);

CREATE TABLE units (
  id serial PRIMARY KEY,
  code varchar(10) NOT NULL UNIQUE,
  title varchar(150) NOT NULL,
  credit_points integer NOT NULL DEFAULT 12
);

CREATE TABLE enrolments (
  student_id integer NOT NULL REFERENCES students(id),
  unit_id integer NOT NULL REFERENCES units(id),
  semester varchar(10) NOT NULL,
  PRIMARY KEY (student_id, unit_id, semester)
);`,
    down: `DROP TABLE enrolments;
DROP TABLE units;
DROP TABLE students;`,
  },
  {
    version: "1.1.0",
    title: "Student phone and status",
    description: "A phone number, and whether a student is active, on leave or graduated.",
    changeType: "additive",
    up: `ALTER TABLE students ADD COLUMN phone varchar(20);
ALTER TABLE students ADD COLUMN status varchar(20) NOT NULL DEFAULT 'active';`,
    down: `ALTER TABLE students DROP COLUMN status;
ALTER TABLE students DROP COLUMN phone;`,
  },
  {
    version: "1.2.0",
    title: "Grades",
    description: "A mark for each enrolment, and a faster lookup of a unit's enrolments.",
    changeType: "additive",
    up: `CREATE TABLE grades (
  student_id integer NOT NULL,
  unit_id integer NOT NULL,
  semester varchar(10) NOT NULL,
  mark integer NOT NULL CHECK (mark >= 0 AND mark <= 100),
  PRIMARY KEY (student_id, unit_id, semester),
  FOREIGN KEY (student_id, unit_id, semester) REFERENCES enrolments (student_id, unit_id, semester)
);

CREATE INDEX enrolments_unit_id_idx ON enrolments (unit_id);`,
    down: `DROP INDEX enrolments_unit_id_idx;
DROP TABLE grades;`,
  },
];

/** The five schemas, and how many of STUDENT_SCRIPTS each student schema has. */
export const STUDENT_SCHEMAS = { students_prod: 1, students_staging: 2, students_dev: 3 } as const;
export const COURSE_SCHEMAS = ["courses_staging", "courses_dev"] as const;
export const TRIAL_SCHEMAS: readonly string[] = [...Object.keys(STUDENT_SCHEMAS), ...COURSE_SCHEMAS];

/** One fixed time for every row, so each reset gives the same data. */
const T = "'2026-09-22 03:24:51+00'";

/** A SQL string literal. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The ledger a deploy makes (app/api/scripts/apply/route.ts, ensureScriptPatchTable). */
const SCRIPT_PATCH_TABLE = `CREATE TABLE script_patch (
  id          SERIAL PRIMARY KEY,
  script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
  version     VARCHAR(20)  NOT NULL,
  title       VARCHAR(150),
  description TEXT,
  change_type VARCHAR(20)  NOT NULL
                CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
  source_ref  TEXT,
  sql_content TEXT,
  down_sql    TEXT,
  applied_by  VARCHAR(320),
  applied_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX script_patch_name_version_idx ON script_patch (script_name, version);`;

/** One student schema with its first `steps` scripts applied and recorded, and its rows. */
function studentSchemaSql(schema: string, steps: number): string {
  const applied = STUDENT_SCRIPTS.slice(0, steps);
  const hasStatus = steps >= 2;
  const hasGrades = steps >= 3;
  const ledger = applied
    .map(
      (script) =>
        `INSERT INTO script_patch (script_name, version, title, description, change_type, sql_content, down_sql, applied_by, applied_at)
VALUES ('students', ${literal(script.version)}, ${literal(script.title)}, ${literal(script.description)}, ${literal(script.changeType)}, ${literal(script.up)}, ${literal(script.down)}, 'the trial', ${T});`
    )
    .join("\n");
  const extra = (phone: string, status: string) => (hasStatus ? `, ${literal(phone)}, ${literal(status)}` : "");

  return `
CREATE SCHEMA ${schema};
SET LOCAL search_path TO ${schema};

${applied.map((script) => script.up).join("\n\n")}

${SCRIPT_PATCH_TABLE}

${ledger}

INSERT INTO students (id, student_number, full_name, email, enrolled_on${hasStatus ? ", phone, status" : ""}) VALUES
  (1, '103456789', 'Aisha Rahman', 'aisha@student.example.edu', '2024-02-26'${extra("0412 345 678", "active")}),
  (2, '103456790', 'Ben Lee', 'ben@student.example.edu', '2024-02-26'${extra("0423 456 789", "on leave")}),
  (3, '103456791', 'Chen Wei', 'chen@student.example.edu', '2023-02-27'${extra("0434 567 890", "active")}),
  (4, '103456792', 'Dana Kovac', 'dana@student.example.edu', '2022-02-28'${extra("0445 678 901", "graduated")});

INSERT INTO units (id, code, title, credit_points) VALUES
  (1, 'COS10009', 'Introduction to Programming', 12),
  (2, 'COS20007', 'Object Oriented Programming', 12),
  (3, 'COS20015', 'Fundamentals of Data Management', 12),
  (4, 'COS40005', 'Computing Technology Project A', 12);

INSERT INTO enrolments (student_id, unit_id, semester) VALUES
  (1, 1, '2024-S1'), (1, 3, '2024-S2'), (2, 1, '2024-S1'),
  (3, 2, '2023-S2'), (3, 3, '2024-S1'), (4, 4, '2024-S2');
${
  hasGrades
    ? `
INSERT INTO grades (student_id, unit_id, semester, mark) VALUES
  (1, 1, '2024-S1', 82), (2, 1, '2024-S1', 67), (3, 2, '2023-S2', 74), (4, 4, '2024-S2', 91);
`
    : ""
}
SELECT setval(pg_get_serial_sequence('students', 'id'), 4);
SELECT setval(pg_get_serial_sequence('units', 'id'), 4);
`;
}

/** One courses schema, with no script ledger. */
function courseSchemaSql(schema: (typeof COURSE_SCHEMAS)[number]): string {
  const isDev = schema === "courses_dev";
  return `
CREATE SCHEMA ${schema};
SET LOCAL search_path TO ${schema};

CREATE TABLE degrees (
  id serial PRIMARY KEY,
  code varchar(10) NOT NULL UNIQUE,
  name varchar(150) NOT NULL,
  years integer NOT NULL${isDev ? ",\n  faculty varchar(100)" : ""}
);

CREATE TABLE courses (
  id serial PRIMARY KEY,
  degree_id integer NOT NULL REFERENCES degrees(id),
  code varchar(10) NOT NULL UNIQUE,
  title varchar(${isDev ? 150 : 100}) NOT NULL,
  credit_points integer NOT NULL DEFAULT 12${isDev ? "" : ",\n  semester_offered varchar(10)"}
);
${
  isDev
    ? `
CREATE TABLE prerequisites (
  course_id integer NOT NULL REFERENCES courses(id),
  requires_course_id integer NOT NULL REFERENCES courses(id),
  PRIMARY KEY (course_id, requires_course_id)
);

CREATE INDEX courses_degree_id_idx ON courses (degree_id);
`
    : `
CREATE INDEX courses_title_idx ON courses (title);
`
}
INSERT INTO degrees (id, code, name, years${isDev ? ", faculty" : ""}) VALUES
  (1, 'BCS', 'Bachelor of Computer Science', 3${isDev ? ", 'Science, Computing and Engineering'" : ""}),
  (2, 'BENG', 'Bachelor of Engineering (Honours)', 4${isDev ? ", 'Science, Computing and Engineering'" : ""}),
  (3, 'BBUS', 'Bachelor of Business', 3${isDev ? ", 'Business, Law and Entrepreneurship'" : ""});

INSERT INTO courses (id, degree_id, code, title, credit_points${isDev ? "" : ", semester_offered"}) VALUES
  (1, 1, 'COS10009', 'Introduction to Programming', 12${isDev ? "" : ", 'S1'"}),
  (2, 1, 'COS20007', 'Object Oriented Programming', 12${isDev ? "" : ", 'S2'"}),
  (3, 1, 'COS30019', 'Introduction to Artificial Intelligence', 12${isDev ? "" : ", 'S1'"}),
  (4, 2, 'ENG10001', 'Engineering Design', 12${isDev ? "" : ", 'S1'"}),
  (5, 3, 'ACC10007', 'Financial Information for Decision Making', 12${isDev ? "" : ", 'S2'"});
${
  isDev
    ? `
INSERT INTO prerequisites (course_id, requires_course_id) VALUES (2, 1), (3, 2);
`
    : ""
}
SELECT setval(pg_get_serial_sequence('degrees', 'id'), 3);
SELECT setval(pg_get_serial_sequence('courses', 'id'), 5);
`;
}

/** The SQL that builds all five schemas, for a database that has none of them. */
export function trialSeedSql(): string {
  return [
    ...Object.entries(STUDENT_SCHEMAS).map(([schema, steps]) => studentSchemaSql(schema, steps)),
    ...COURSE_SCHEMAS.map(courseSchemaSql),
    "RESET search_path;",
  ].join("\n");
}
