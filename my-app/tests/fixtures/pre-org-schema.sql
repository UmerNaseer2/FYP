-- The app's metadata database as it was before organizations, from the last
-- build without them (f8d725d). tests/org-migration.test.ts loads it into an
-- empty database, adds rows of its own, and checks what lib/db/bootstrap.ts
-- makes of it.
--
-- Made with pg_dump 17 from a database that build had created: schema only,
-- without owners or privileges, so there are no rows in it. pg_dump's comments
-- and session settings were taken out. Every name below is qualified with its
-- schema, so nothing here depends on the search_path.

CREATE TABLE public.comparison_runs (
    id integer NOT NULL,
    set_id integer,
    source_connection_id integer NOT NULL,
    source_schema text NOT NULL,
    target_connection_id integer NOT NULL,
    target_schema text NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    ran_by text NOT NULL,
    total_changes integer NOT NULL,
    breaking_changes integer NOT NULL,
    safe_changes integer NOT NULL,
    info_changes integer NOT NULL,
    fingerprint text NOT NULL,
    findings jsonb NOT NULL
);

CREATE SEQUENCE public.comparison_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.comparison_runs_id_seq OWNED BY public.comparison_runs.id;

CREATE TABLE public.comparison_set_targets (
    id integer NOT NULL,
    set_id integer NOT NULL,
    "position" integer NOT NULL,
    connection_id integer,
    connection_label text DEFAULT ''::text NOT NULL,
    schema_name text NOT NULL
);

CREATE SEQUENCE public.comparison_set_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.comparison_set_targets_id_seq OWNED BY public.comparison_set_targets.id;

CREATE TABLE public.comparison_sets (
    id integer NOT NULL,
    name text NOT NULL,
    source_connection_id integer,
    source_connection_label text DEFAULT ''::text NOT NULL,
    source_schema text NOT NULL,
    allow_data_loss boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run_at timestamp with time zone,
    compare_data boolean DEFAULT false NOT NULL,
    data_tables jsonb
);

CREATE SEQUENCE public.comparison_sets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.comparison_sets_id_seq OWNED BY public.comparison_sets.id;

CREATE TABLE public.connections (
    id integer NOT NULL,
    name text NOT NULL,
    host text NOT NULL,
    port integer DEFAULT 5432 NOT NULL,
    database_name text DEFAULT 'postgres'::text NOT NULL,
    type text DEFAULT 'PostgreSQL'::text NOT NULL,
    username text NOT NULL,
    password text NOT NULL,
    connection_string text,
    ssl boolean DEFAULT false NOT NULL,
    ssl_mode text DEFAULT 'disable'::text NOT NULL,
    environment text DEFAULT 'unset'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_tested_at timestamp with time zone,
    last_test_ok boolean,
    last_test_version text,
    last_test_latency_ms integer,
    last_test_error text,
    application_table text,
    execute_role text DEFAULT 'editor'::text NOT NULL,
    CONSTRAINT connections_environment_check CHECK ((environment = ANY (ARRAY['unset'::text, 'dev'::text, 'staging'::text, 'prod'::text]))),
    CONSTRAINT connections_ssl_mode_check CHECK ((ssl_mode = ANY (ARRAY['disable'::text, 'require'::text, 'verify-full'::text])))
);

CREATE SEQUENCE public.connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.connections_id_seq OWNED BY public.connections.id;

CREATE TABLE public.deploy_approvals (
    id integer NOT NULL,
    connection_id integer NOT NULL,
    schema_name text NOT NULL,
    script_name text NOT NULL,
    target_version text NOT NULL,
    run_fingerprint text NOT NULL,
    migration_count integer NOT NULL,
    breaking_count integer DEFAULT 0 NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    self_approved boolean DEFAULT false NOT NULL,
    note text,
    used_at timestamp with time zone,
    action text DEFAULT 'deploy'::text NOT NULL,
    expires_at timestamp with time zone,
    scripts jsonb,
    CONSTRAINT deploy_approvals_action_check CHECK ((action = ANY (ARRAY['deploy'::text, 'revert'::text]))),
    CONSTRAINT deploy_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'used'::text]))),
    CONSTRAINT deploy_approvals_two_person_check CHECK (((decided_by IS NULL) OR self_approved OR (lower(decided_by) <> lower(requested_by))))
);

CREATE SEQUENCE public.deploy_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deploy_approvals_id_seq OWNED BY public.deploy_approvals.id;

CREATE TABLE public.deploy_attempts (
    id integer NOT NULL,
    connection_id integer,
    schema_name text,
    scripts jsonb DEFAULT '[]'::jsonb NOT NULL,
    outcome text NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    http_status integer NOT NULL,
    detail text,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deploy_attempts_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'failed'::text, 'refused'::text, 'unknown'::text])))
);

CREATE SEQUENCE public.deploy_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deploy_attempts_id_seq OWNED BY public.deploy_attempts.id;

CREATE TABLE public.drift_events (
    id integer NOT NULL,
    tracked_schema_id integer NOT NULL,
    status text NOT NULL,
    summary text,
    detail jsonb,
    baseline_snapshot_id integer,
    detected_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at timestamp with time zone,
    source text DEFAULT 'manual'::text NOT NULL,
    fingerprint text,
    CONSTRAINT drift_events_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'scheduled'::text, 'tracking'::text, 'deploy'::text, 'rebaseline'::text, 'acknowledged'::text])))
);

CREATE SEQUENCE public.drift_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.drift_events_id_seq OWNED BY public.drift_events.id;

CREATE TABLE public.lineage_migrations (
    id integer NOT NULL,
    tracked_schema_id integer NOT NULL,
    seq integer NOT NULL,
    name text NOT NULL,
    change_level text NOT NULL,
    version text NOT NULL,
    sql_ref text,
    snapshot_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.lineage_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lineage_migrations_id_seq OWNED BY public.lineage_migrations.id;

CREATE TABLE public.perf_thresholds (
    id integer NOT NULL,
    connection_id integer NOT NULL,
    schema_name text NOT NULL,
    threshold_key text NOT NULL,
    threshold_value double precision NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT perf_thresholds_key_check CHECK ((threshold_key = ANY (ARRAY['query_exec_ms'::text, 'query_score'::text, 'long_running_seconds'::text, 'cache_hit_ratio'::text, 'dead_row_ratio'::text])))
);

CREATE SEQUENCE public.perf_thresholds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.perf_thresholds_id_seq OWNED BY public.perf_thresholds.id;

CREATE TABLE public.profiles (
    id integer NOT NULL,
    email text NOT NULL,
    name text,
    role text DEFAULT 'viewer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone
);

CREATE SEQUENCE public.profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.profiles_id_seq OWNED BY public.profiles.id;

CREATE TABLE public.query_history (
    id integer NOT NULL,
    connection_id integer NOT NULL,
    schema_name text NOT NULL,
    query_text text NOT NULL,
    fingerprint text NOT NULL,
    exec_time_ms double precision,
    planning_ms double precision,
    rows_returned bigint,
    total_cost double precision DEFAULT '0'::double precision NOT NULL,
    estimated_rows double precision DEFAULT '0'::double precision NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    band text DEFAULT 'good'::text NOT NULL,
    measured boolean DEFAULT false NOT NULL,
    high_count integer DEFAULT 0 NOT NULL,
    medium_count integer DEFAULT 0 NOT NULL,
    low_count integer DEFAULT 0 NOT NULL,
    captured_by text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    searched_columns jsonb,
    CONSTRAINT query_history_band_check CHECK ((band = ANY (ARRAY['good'::text, 'fair'::text, 'poor'::text]))),
    CONSTRAINT query_history_measured_check CHECK ((measured OR ((exec_time_ms IS NULL) AND (rows_returned IS NULL)))),
    CONSTRAINT query_history_score_check CHECK (((score >= 0) AND (score <= 100)))
);

CREATE SEQUENCE public.query_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.query_history_id_seq OWNED BY public.query_history.id;

CREATE TABLE public.role_changes (
    id integer NOT NULL,
    role text NOT NULL,
    kind text NOT NULL,
    feature text,
    action text,
    subject text,
    detail text,
    actor text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_changes_kind_check CHECK ((kind = ANY (ARRAY['create-role'::text, 'delete-role'::text, 'grant'::text, 'revoke'::text, 'reset'::text, 'assign'::text])))
);

CREATE SEQUENCE public.role_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.role_changes_id_seq OWNED BY public.role_changes.id;

CREATE TABLE public.role_permissions (
    role text NOT NULL,
    feature text NOT NULL,
    action text NOT NULL
);

CREATE TABLE public.roles (
    name text NOT NULL,
    label text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    built_in boolean DEFAULT false NOT NULL,
    preset_applied jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_name_check CHECK ((name ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text))
);

CREATE TABLE public.schema_metrics (
    id integer NOT NULL,
    tracked_schema_id integer NOT NULL,
    tables integer DEFAULT 0 NOT NULL,
    columns integer DEFAULT 0 NOT NULL,
    indexes integer DEFAULT 0 NOT NULL,
    foreign_keys integer DEFAULT 0 NOT NULL,
    views integer DEFAULT 0 NOT NULL,
    routines integer DEFAULT 0 NOT NULL,
    total_bytes bigint,
    index_bytes bigint,
    estimated_rows bigint,
    drifted boolean DEFAULT false NOT NULL,
    sampled_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.schema_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.schema_metrics_id_seq OWNED BY public.schema_metrics.id;

CREATE TABLE public.snapshots (
    id integer NOT NULL,
    tracked_schema_id integer NOT NULL,
    snapshot jsonb NOT NULL,
    table_count integer DEFAULT 0 NOT NULL,
    label text,
    captured_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE SEQUENCE public.snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.snapshots_id_seq OWNED BY public.snapshots.id;

CREATE TABLE public.tracked_schemas (
    id integer NOT NULL,
    connection_id integer NOT NULL,
    schema_name text NOT NULL,
    label text,
    environment text DEFAULT 'unset'::text NOT NULL,
    drift_check_interval_minutes integer DEFAULT 15 NOT NULL,
    last_drift_check_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tracked_schemas_drift_interval_check CHECK (((drift_check_interval_minutes >= 0) AND (drift_check_interval_minutes <= 10080))),
    CONSTRAINT tracked_schemas_environment_check CHECK ((environment = ANY (ARRAY['unset'::text, 'dev'::text, 'staging'::text, 'prod'::text])))
);

CREATE SEQUENCE public.tracked_schemas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tracked_schemas_id_seq OWNED BY public.tracked_schemas.id;

ALTER TABLE ONLY public.comparison_runs ALTER COLUMN id SET DEFAULT nextval('public.comparison_runs_id_seq'::regclass);

ALTER TABLE ONLY public.comparison_set_targets ALTER COLUMN id SET DEFAULT nextval('public.comparison_set_targets_id_seq'::regclass);

ALTER TABLE ONLY public.comparison_sets ALTER COLUMN id SET DEFAULT nextval('public.comparison_sets_id_seq'::regclass);

ALTER TABLE ONLY public.connections ALTER COLUMN id SET DEFAULT nextval('public.connections_id_seq'::regclass);

ALTER TABLE ONLY public.deploy_approvals ALTER COLUMN id SET DEFAULT nextval('public.deploy_approvals_id_seq'::regclass);

ALTER TABLE ONLY public.deploy_attempts ALTER COLUMN id SET DEFAULT nextval('public.deploy_attempts_id_seq'::regclass);

ALTER TABLE ONLY public.drift_events ALTER COLUMN id SET DEFAULT nextval('public.drift_events_id_seq'::regclass);

ALTER TABLE ONLY public.lineage_migrations ALTER COLUMN id SET DEFAULT nextval('public.lineage_migrations_id_seq'::regclass);

ALTER TABLE ONLY public.perf_thresholds ALTER COLUMN id SET DEFAULT nextval('public.perf_thresholds_id_seq'::regclass);

ALTER TABLE ONLY public.profiles ALTER COLUMN id SET DEFAULT nextval('public.profiles_id_seq'::regclass);

ALTER TABLE ONLY public.query_history ALTER COLUMN id SET DEFAULT nextval('public.query_history_id_seq'::regclass);

ALTER TABLE ONLY public.role_changes ALTER COLUMN id SET DEFAULT nextval('public.role_changes_id_seq'::regclass);

ALTER TABLE ONLY public.schema_metrics ALTER COLUMN id SET DEFAULT nextval('public.schema_metrics_id_seq'::regclass);

ALTER TABLE ONLY public.snapshots ALTER COLUMN id SET DEFAULT nextval('public.snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.tracked_schemas ALTER COLUMN id SET DEFAULT nextval('public.tracked_schemas_id_seq'::regclass);

ALTER TABLE ONLY public.comparison_runs
    ADD CONSTRAINT comparison_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comparison_set_targets
    ADD CONSTRAINT comparison_set_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comparison_sets
    ADD CONSTRAINT comparison_sets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deploy_approvals
    ADD CONSTRAINT deploy_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deploy_attempts
    ADD CONSTRAINT deploy_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drift_events
    ADD CONSTRAINT drift_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lineage_migrations
    ADD CONSTRAINT lineage_migrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.perf_thresholds
    ADD CONSTRAINT perf_thresholds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.query_history
    ADD CONSTRAINT query_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.role_changes
    ADD CONSTRAINT role_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role, feature, action);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.schema_metrics
    ADD CONSTRAINT schema_metrics_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tracked_schemas
    ADD CONSTRAINT tracked_schemas_pkey PRIMARY KEY (id);

CREATE INDEX comparison_runs_pair_idx ON public.comparison_runs USING btree (source_connection_id, source_schema, target_connection_id, target_schema, ran_at DESC);

CREATE INDEX comparison_runs_set_id_idx ON public.comparison_runs USING btree (set_id);

CREATE INDEX comparison_set_targets_connection_id_idx ON public.comparison_set_targets USING btree (connection_id);

CREATE UNIQUE INDEX comparison_set_targets_position_key ON public.comparison_set_targets USING btree (set_id, "position");

CREATE UNIQUE INDEX comparison_sets_name_key ON public.comparison_sets USING btree (lower(name));

CREATE INDEX comparison_sets_source_connection_id_idx ON public.comparison_sets USING btree (source_connection_id);

CREATE INDEX deploy_approvals_target_idx ON public.deploy_approvals USING btree (connection_id, schema_name, script_name, status);

CREATE INDEX deploy_attempts_target_idx ON public.deploy_attempts USING btree (connection_id, schema_name, created_at);

CREATE INDEX drift_events_baseline_snapshot_id_idx ON public.drift_events USING btree (baseline_snapshot_id);

CREATE INDEX drift_events_tracked_schema_id_detected_at_idx ON public.drift_events USING btree (tracked_schema_id, detected_at);

CREATE INDEX lineage_migrations_snapshot_id_idx ON public.lineage_migrations USING btree (snapshot_id);

CREATE UNIQUE INDEX lineage_migrations_tracked_schema_id_seq_key ON public.lineage_migrations USING btree (tracked_schema_id, seq);

CREATE UNIQUE INDEX perf_thresholds_target_key_idx ON public.perf_thresholds USING btree (connection_id, schema_name, threshold_key);

CREATE UNIQUE INDEX profiles_email_key_idx ON public.profiles USING btree (lower(email));

CREATE INDEX query_history_fingerprint_idx ON public.query_history USING btree (fingerprint, captured_at);

CREATE INDEX query_history_target_captured_at_idx ON public.query_history USING btree (connection_id, schema_name, captured_at);

CREATE UNIQUE INDEX roles_label_key ON public.roles USING btree (lower(label));

CREATE INDEX schema_metrics_tracked_schema_id_sampled_at_idx ON public.schema_metrics USING btree (tracked_schema_id, sampled_at);

CREATE INDEX snapshots_tracked_schema_id_captured_at_idx ON public.snapshots USING btree (tracked_schema_id, captured_at);

CREATE UNIQUE INDEX tracked_schemas_connection_id_schema_name_key ON public.tracked_schemas USING btree (connection_id, schema_name);

ALTER TABLE ONLY public.comparison_runs
    ADD CONSTRAINT comparison_runs_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.comparison_sets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.comparison_runs
    ADD CONSTRAINT comparison_runs_source_connection_id_fkey FOREIGN KEY (source_connection_id) REFERENCES public.connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comparison_runs
    ADD CONSTRAINT comparison_runs_target_connection_id_fkey FOREIGN KEY (target_connection_id) REFERENCES public.connections(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comparison_set_targets
    ADD CONSTRAINT comparison_set_targets_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.comparison_set_targets
    ADD CONSTRAINT comparison_set_targets_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.comparison_sets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.comparison_sets
    ADD CONSTRAINT comparison_sets_source_connection_id_fkey FOREIGN KEY (source_connection_id) REFERENCES public.connections(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.drift_events
    ADD CONSTRAINT drift_events_baseline_snapshot_id_fkey FOREIGN KEY (baseline_snapshot_id) REFERENCES public.snapshots(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.drift_events
    ADD CONSTRAINT drift_events_tracked_schema_id_fkey FOREIGN KEY (tracked_schema_id) REFERENCES public.tracked_schemas(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.lineage_migrations
    ADD CONSTRAINT lineage_migrations_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.snapshots(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.lineage_migrations
    ADD CONSTRAINT lineage_migrations_tracked_schema_id_fkey FOREIGN KEY (tracked_schema_id) REFERENCES public.tracked_schemas(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_role_fkey FOREIGN KEY (role) REFERENCES public.roles(name) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_fkey FOREIGN KEY (role) REFERENCES public.roles(name) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.schema_metrics
    ADD CONSTRAINT schema_metrics_tracked_schema_id_fkey FOREIGN KEY (tracked_schema_id) REFERENCES public.tracked_schemas(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_tracked_schema_id_fkey FOREIGN KEY (tracked_schema_id) REFERENCES public.tracked_schemas(id) ON UPDATE CASCADE ON DELETE CASCADE;
