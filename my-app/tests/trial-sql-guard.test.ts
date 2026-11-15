import { trialSqlProblem, trialSqlRefusal } from "@/lib/trial-sql-guard";
import { STUDENT_SCRIPTS } from "@/lib/trial-seed";

// What a trial run refuses (lib/trial-sql-guard.ts). Every visitor shares one
// database user, so a script that changes that user, its session settings or
// the server would break the trial for everyone after it.

describe("trialSqlProblem refuses what reaches every other visitor", () => {
  it.each([
    // The two found in review.
    ["ALTER ROLE CURRENT_USER PASSWORD 'x';", "runs ALTER ROLE"],
    ["ALTER ROLE CURRENT_USER SET default_transaction_read_only = on;", "runs ALTER ROLE"],
    // The same, written other ways.
    ["alter   user\n current_user password 'x'", "runs ALTER USER"],
    ["ALTER ROLE CURRENT_USER IN DATABASE neondb SET statement_timeout = 0", "runs ALTER ROLE"],
    ["-- tidy up\nALTER ROLE trial_sandbox RESET ALL;", "runs ALTER ROLE"],
    ["CREATE TABLE t (id int); alter role current_user nologin;", "runs ALTER ROLE"],
    ["ALTER DATABASE neondb SET default_transaction_read_only = on;", "runs ALTER DATABASE"],
    ["CREATE ROLE helper LOGIN PASSWORD 'x';", "runs CREATE ROLE"],
    ["ALTER SYSTEM SET work_mem = '1GB';", "runs ALTER SYSTEM"],
    ["LOAD 'auto_explain';", "runs LOAD"],
    ["CREATE EXTENSION IF NOT EXISTS dblink;", "runs CREATE EXTENSION"],
    ["CREATE OR REPLACE TRUSTED LANGUAGE plsample HANDLER h;", "runs CREATE OR REPLACE TRUSTED LANGUAGE"],
    ["CREATE PUBLICATION p FOR ALL TABLES;", "runs CREATE PUBLICATION"],
    ["CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION f();", "runs CREATE EVENT TRIGGER"],
    ["GRANT pg_read_server_files TO CURRENT_USER;", "runs GRANT of a role"],
    ["DROP OWNED BY CURRENT_USER;", "runs DROP OWNED"],
    ["REASSIGN OWNED BY CURRENT_USER TO postgres;", "runs REASSIGN OWNED"],
    ["ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC;", "runs ALTER DEFAULT PRIVILEGES"],
    ["COMMENT ON LARGE OBJECT 1 IS 'x';", "uses large objects"],
    // The session's limits and transaction settings.
    ["SET statement_timeout = 0;", "changes the setting statement_timeout"],
    ["SET LOCAL statement_timeout TO DEFAULT;", "changes the setting statement_timeout"],
    ['SET "statement_timeout" = 0;', "changes the setting statement_timeout"],
    ["CREATE TABLE t (id int);\nSET SESSION idle_in_transaction_session_timeout = 0;", "changes the setting idle_in_transaction_session_timeout"],
    ["SET default_transaction_read_only = on;", "changes the setting default_transaction_read_only"],
    ["SET transaction_read_only = on;", "changes the setting transaction_read_only"],
    ["SET work_mem = '2GB';", "changes the setting work_mem"],
    ["SET client_encoding = 'SJIS';", "changes the setting client_encoding"],
    ["RESET ALL;", "runs RESET ALL"],
    ["SET ROLE NONE;", "runs SET ROLE"],
    ["SET SESSION AUTHORIZATION DEFAULT;", "runs SET SESSION AUTHORIZATION"],
    ["SET NAMES 'LATIN1';", "runs SET NAMES"],
    ["SET TRANSACTION READ ONLY;", "runs SET TRANSACTION"],
    ["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;", "runs SET SESSION CHARACTERISTICS"],
    ["SELECT set_config('statement_timeout', '0', false);", "changes a setting with set_config()"],
    ['SELECT pg_catalog."set_config"(\'default_transaction_read_only\', \'on\', false);', "changes a setting with set_config()"],
    ["SELECT set_config(lower('STATEMENT_TIMEOUT'), '0', false);", "changes a setting with set_config()"],
    ["UPDATE pg_settings SET setting = '0' WHERE name = 'statement_timeout';", "uses pg_settings, which can change the session's settings"],
    [
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET application_name = 'x' AS 'SELECT 1';",
      "uses application_name, which the trial uses to find a run it has to stop",
    ],
    // A function's own SET clause hands the function the memory.
    ["CREATE FUNCTION f() RETURNS int LANGUAGE sql SET work_mem = '4GB' AS 'SELECT 1';", "changes the setting work_mem"],
    ['ALTER FUNCTION f() SET "maintenance_work_mem" TO \'2GB\';', "changes the setting maintenance_work_mem"],
    // An operator or an aggregate names the function it runs, in a string if
    // it likes, so no call to it is ever written.
    [
      "CREATE AGGREGATE agg(text, boolean) (SFUNC = set_config, STYPE = text, INITCOND = 'statement_timeout');",
      "runs CREATE AGGREGATE, which can call a function this check cannot see",
    ],
    [
      "CREATE OPERATOR ### (RIGHTARG = int, FUNCTION = 'pg_cancel_backend');",
      "runs CREATE OPERATOR, which can call a function this check cannot see",
    ],
    [
      "CREATE OR REPLACE AGGREGATE agg(int) (SFUNC = int4pl, STYPE = int);",
      "runs CREATE OR REPLACE AGGREGATE, which can call a function this check cannot see",
    ],
    [
      "ALTER OPERATOR = (int, int) SET (RESTRICT = 'eqsel');",
      "runs ALTER OPERATOR, which can call a function this check cannot see",
    ],
    ["SELECT pg_catalog.set_config\n('statement_timeout', '0', false);", "changes a setting with set_config()"],
    // SQL run from a string, which nothing can read.
    ["SELECT query_to_xml('ALTER ROLE CURRENT_USER NOLOGIN', true, false, '');", "calls query_to_xml(), which runs SQL written in a string"],
    ["SELECT * FROM pg_catalog.ts_stat ('SELECT 1');", "calls ts_stat(), which runs SQL written in a string"],
    ["SELECT lo_create(0);", "calls lo_create(), which uses large objects"],
  ])("%s", (sql, problem) => {
    expect(trialSqlProblem(sql)).toBe(problem);
  });

  it("reads the body of a DO block, however it is quoted", () => {
    expect(trialSqlProblem("DO $$ BEGIN ALTER ROLE CURRENT_USER PASSWORD 'x'; END $$;")).toBe(
      "runs ALTER ROLE"
    );
    expect(
      trialSqlProblem("DO 'BEGIN ALTER ROLE CURRENT_USER SET default_transaction_read_only = on; END';")
    ).toBe("runs ALTER ROLE");
    expect(trialSqlProblem("DO E'BEGIN SET statement_timeout = 0; END';")).toBe(
      "changes the setting statement_timeout"
    );
    expect(
      trialSqlProblem("DO $outer$ BEGIN IF true THEN SET LOCAL work_mem = '4GB'; END IF; END $outer$;")
    ).toBe("changes the setting work_mem");
    // A string carried on to the next line is one string: 'BEGIN ALTER ROLE ...'.
    expect(trialSqlProblem("DO 'BEGIN ALTER '\n'ROLE CURRENT_USER PASSWORD ''x''; END';")).toBe(
      "runs ALTER ROLE"
    );
  });

  it("reads the body of a function, and a body inside a body", () => {
    expect(
      trialSqlProblem(
        "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ ALTER ROLE CURRENT_USER PASSWORD 'x' $$;"
      )
    ).toBe("runs ALTER ROLE");
    expect(
      trialSqlProblem(
        "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$\n" +
          "BEGIN\n  PERFORM set_config('statement_timeout', '0', false);\nEND\n$f$;"
      )
    ).toBe("changes a setting with set_config()");
    expect(
      trialSqlProblem(
        "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN " +
          "EXECUTE $q$ DO $d$ BEGIN NULL; END $d$ $q$; END $f$;"
      )
    ).toBe("runs SQL written in a string (EXECUTE)");
    expect(
      trialSqlProblem(
        "CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT pg_terminate_backend(1); END;"
      )
    ).toMatch(/pg_terminate_backend\(\), which acts on the server or on another visitor's connection/);
  });

  it("refuses SQL written in a string, since it cannot be read", () => {
    expect(
      trialSqlProblem(
        "DO $$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L', current_user, 'x'); END $$;"
      )
    ).toBe("runs SQL written in a string (EXECUTE)");
  });

  it("refuses a call that reaches another visitor's connection", () => {
    expect(trialSqlProblem("SELECT pg_cancel_backend(pid) FROM pg_stat_activity;")).toMatch(
      /^calls pg_cancel_backend\(\)/
    );
    expect(trialSqlProblem('SELECT "pg_terminate_backend"(1);')).toMatch(/^calls pg_terminate_backend\(\)/);
  });

  it("refuses what it cannot read", () => {
    expect(trialSqlProblem("DO U&'BEGIN NULL; END';")).toBe(
      "has a DO block or function body written in a way the trial cannot read"
    );
    expect(trialSqlProblem('SELECT U&"\\0070g_sleep"(1);')).toBe(
      "uses a U& escaped name, which the trial cannot read"
    );
  });
});

describe("trialSqlProblem lets ordinary scripts run", () => {
  it.each([
    "CREATE TABLE students (id serial PRIMARY KEY, role text NOT NULL, owned boolean);",
    "ALTER TABLE students ALTER role TYPE varchar(40);",
    "ALTER TABLE students DROP owned;",
    "ALTER TABLE students RENAME COLUMN role TO position;",
    "COMMENT ON TABLE students IS 'Do not ALTER ROLE CURRENT_USER PASSWORD here, or SET statement_timeout';",
    "-- ALTER ROLE CURRENT_USER PASSWORD 'x'\nCREATE INDEX ON students (role);",
    "/* SET statement_timeout = 0; */ SELECT 1;",
    "SET search_path TO students_dev, public;",
    "SET LOCAL lock_timeout = '5s';",
    "SET client_min_messages = warning;",
    "SET TIME ZONE 'UTC';",
    "SET CONSTRAINTS ALL DEFERRED;",
    "SELECT set_config('search_path', '', false);",
    "SELECT pg_catalog.set_config('search_path', '', false);",
    "SELECT \"set_config\"('search_path', 'students_dev', false);",
    "SELECT proname FROM pg_proc WHERE proname IN ('set_config', 'ts_stat');",
    "SELECT pg_sleep(2);",
    "GRANT SELECT ON students TO PUBLIC;",
    "REVOKE ALL ON FUNCTION f() FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION f() TO PUBLIC;",
    "ALTER TABLE students OWNER TO CURRENT_USER;",
    "CREATE TRIGGER trg BEFORE INSERT ON students FOR EACH ROW EXECUTE FUNCTION touch();",
    "CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql SET search_path = students_dev " +
      "AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;",
    "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET statement_timeout = '1s' AS 'SELECT 1';",
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grade') THEN " +
      "CREATE TYPE grade AS ENUM ('HD', 'D'); END IF; END $$;",
    "INSERT INTO notes (body) VALUES ('RESET ALL; SET ROLE admin; SELECT set_config(''x'', ''1'', false)');",
    "CREATE TABLE user_settings (id int);",
    "DROP TABLE IF EXISTS role_assignments;",
  ])("%s", (sql) => {
    expect(trialSqlProblem(sql)).toBeNull();
  });

  it("lets every script in the trial's own history run, and roll back", () => {
    for (const script of STUDENT_SCRIPTS) {
      expect({ version: script.version, up: trialSqlProblem(script.up) }).toEqual({
        version: script.version,
        up: null,
      });
      expect({ version: script.version, down: trialSqlProblem(script.down) }).toEqual({
        version: script.version,
        down: null,
      });
    }
  });
});

describe("trialSqlRefusal", () => {
  it("names what was read and says nothing ran", () => {
    expect(trialSqlRefusal('The script "add_orders"', "runs ALTER ROLE")).toBe(
      'The script "add_orders" runs ALTER ROLE. Every visitor to the trial shares one database ' +
        "user, so the trial does not run that. Nothing was run."
    );
  });
});
