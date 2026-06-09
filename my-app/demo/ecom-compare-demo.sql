-- =============================================================================
-- E-COMMERCE COMPARE DEMO  —  two schemas in ONE database
-- Run this in the Neon SQL editor (or psql / pgAdmin) against your target DB.
--
-- It creates two schemas on the same connection:
--   ecom          — the "before" / baseline schema
--   ecom_updated  — the "after"  / evolved schema (same app, a few releases later)
--
-- Then point the app's /compare page at:
--   left  connection = <this DB>,  left schema  = ecom
--   right connection = <this DB>,  right schema = ecom_updated
--
-- Every difference below is hand-picked to exercise ONE feature of the compare
-- engine (see the "DEMONSTRATES" note on each table). The script is re-runnable:
-- it drops and recreates both schemas every time.
--
-- ─── What each change is meant to show ──────────────────────────────────────
--   customers     possible column rename (full_name→customer_name), column
--                 removed (fax), column added (phone_verified), nullability
--                 change (phone, customer_name → NOT NULL), unique added (phone),
--                 type change different-base (loyalty_points INT→BIGINT)
--   categories    NO CHANGE — a control table, proves clean matches stay quiet
--   products      accepted column rename (descr→description), type WIDENING
--                 (name varchar 120→200), column added + unique (slug),
--                 check added (price >= 0), column-order shift
--   addresses     foreign-key changed (ON DELETE NO ACTION → CASCADE),
--                 column added (is_default)
--   cart          TABLE RENAME → shopping_cart (identical structure, new name)
--   cart_items    primary key changed (surrogate id → composite natural key),
--                 column removed (id), unique replaced by PK, FK retargeted
--   orders        type widening (total 10,2→12,2), column added
--                 (shipping_method), check added (status whitelist)
--   order_items   type NARROWING (unit_price 12,2→10,2 — flagged breaking),
--                 foreign-key changed (product_id NO ACTION → RESTRICT)
--   flash_sales   EXCLUDE constraint changed + column type change
--                 (sale_period TSTZRANGE→DATERANGE), widening (discount_pct)
--   legacy_coupons   table REMOVED (only in ecom)
--   product_reviews  table ADDED (only in ecom_updated; FKs + check + unique)
--   script_patch  the deploy ledger — present in BOTH and IGNORED by compare
-- =============================================================================

-- EXCLUDE constraints with an "=" on an integer column need btree_gist.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP SCHEMA IF EXISTS ecom         CASCADE;
DROP SCHEMA IF EXISTS ecom_updated CASCADE;
CREATE SCHEMA ecom;
CREATE SCHEMA ecom_updated;


-- =============================================================================
--  ecom  —  BASELINE
-- =============================================================================

CREATE TABLE ecom.customers (
    id             SERIAL PRIMARY KEY,
    email          VARCHAR(255) NOT NULL UNIQUE,
    full_name      VARCHAR(150),
    phone          VARCHAR(30),
    fax            VARCHAR(30),
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ecom.categories (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(100) NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES ecom.categories(id) ON DELETE SET NULL
);

CREATE TABLE ecom.products (
    id          SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES ecom.categories(id) ON DELETE SET NULL,
    sku         VARCHAR(64) NOT NULL UNIQUE,
    name        VARCHAR(120) NOT NULL,
    descr       TEXT,
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ecom.addresses (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES ecom.customers(id),   -- default ON DELETE NO ACTION
    line1       VARCHAR(200) NOT NULL,
    city        VARCHAR(100),
    postal_code VARCHAR(20),
    country     VARCHAR(2) NOT NULL DEFAULT 'US'
);

CREATE TABLE ecom.cart (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES ecom.customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ecom.cart_items (
    id         SERIAL PRIMARY KEY,
    cart_id    INTEGER NOT NULL REFERENCES ecom.cart(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES ecom.products(id),
    quantity   INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT cart_items_unique UNIQUE (cart_id, product_id)
);

CREATE TABLE ecom.orders (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES ecom.customers(id),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    total       NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ecom.order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES ecom.orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES ecom.products(id),
    quantity   INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(12,2) NOT NULL
);

CREATE TABLE ecom.flash_sales (
    id           SERIAL PRIMARY KEY,
    product_id   INTEGER NOT NULL REFERENCES ecom.products(id) ON DELETE CASCADE,
    discount_pct NUMERIC(5,2) NOT NULL,
    sale_period  TSTZRANGE NOT NULL,
    -- one product can't have two overlapping flash sales
    CONSTRAINT flash_sales_no_overlap EXCLUDE USING gist (product_id WITH =, sale_period WITH &&)
);

CREATE TABLE ecom.legacy_coupons (          -- removed in ecom_updated
    id     SERIAL PRIMARY KEY,
    code   VARCHAR(40) NOT NULL UNIQUE,
    amount NUMERIC(8,2) NOT NULL
);

-- Deploy ledger — IGNORED by the compare engine (it skips any table named script_patch)
CREATE TABLE ecom.script_patch (
    id          SERIAL PRIMARY KEY,
    script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
    version     VARCHAR(20)  NOT NULL,
    title       VARCHAR(150),
    description TEXT,
    change_type VARCHAR(20)  NOT NULL
                  CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
    source_ref  TEXT,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ecom_sp_name_ver_idx ON ecom.script_patch (script_name, version);

-- ─── ecom sample data ───────────────────────────────────────────────────────
INSERT INTO ecom.categories (name) VALUES ('Electronics'), ('Books');

INSERT INTO ecom.customers (email, full_name, phone, fax, loyalty_points) VALUES
    ('alice@example.com', 'Alice Chen', '+1-202-555-0101', '+1-202-555-0900', 120),
    ('bob@example.com',   'Bob Smith',  '+1-202-555-0102', NULL,              0);

INSERT INTO ecom.products (category_id, sku, name, descr, price, stock) VALUES
    (1, 'ELEC-001', 'USB-C Charger', '65W fast charger', 29.99, 250),
    (2, 'BOOK-001', 'Postgres Up & Running', 'OReilly title', 39.50, 40);

INSERT INTO ecom.orders (customer_id, status, total) VALUES
    (1, 'paid',    69.49),
    (2, 'pending', 39.50);

INSERT INTO ecom.script_patch (script_name, version, title, description, change_type, applied_at) VALUES
    ('ecom_schema', '1.0.0', 'Initial e-commerce schema', 'Baseline tables', 'additive', '2025-02-01 09:00:00');


-- =============================================================================
--  ecom_updated  —  EVOLVED  (a few releases later)
-- =============================================================================

CREATE TABLE ecom_updated.customers (
    id             SERIAL PRIMARY KEY,
    email          VARCHAR(255) NOT NULL UNIQUE,
    customer_name  VARCHAR(150) NOT NULL,            -- renamed from full_name + now NOT NULL
    phone          VARCHAR(30)  NOT NULL UNIQUE,     -- now NOT NULL + gained a UNIQUE constraint
    phone_verified BOOLEAN      NOT NULL DEFAULT false,  -- new column
    loyalty_points BIGINT       NOT NULL DEFAULT 0,  -- INTEGER → BIGINT (different base = breaking)
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    -- fax dropped
);

-- Unchanged control table — identical to ecom.categories
CREATE TABLE ecom_updated.categories (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(100) NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES ecom_updated.categories(id) ON DELETE SET NULL
);

CREATE TABLE ecom_updated.products (
    id          SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES ecom_updated.categories(id) ON DELETE SET NULL,
    sku         VARCHAR(64)  NOT NULL UNIQUE,
    slug        VARCHAR(160) NOT NULL UNIQUE,        -- new column + unique
    name        VARCHAR(200) NOT NULL,               -- widened from VARCHAR(120)
    description TEXT,                                 -- renamed from descr
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_price_nonneg CHECK (price >= 0)   -- new check constraint
);

CREATE TABLE ecom_updated.addresses (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL
                REFERENCES ecom_updated.customers(id) ON DELETE CASCADE,  -- FK action changed
    line1       VARCHAR(200) NOT NULL,
    city        VARCHAR(100),
    postal_code VARCHAR(20),
    country     VARCHAR(2) NOT NULL DEFAULT 'US',
    is_default  BOOLEAN NOT NULL DEFAULT false        -- new column
);

-- renamed from ecom.cart (identical structure → high-confidence table rename)
CREATE TABLE ecom_updated.shopping_cart (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES ecom_updated.customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ecom_updated.cart_items (
    cart_id    INTEGER NOT NULL REFERENCES ecom_updated.shopping_cart(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES ecom_updated.products(id),
    quantity   INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (cart_id, product_id)                -- surrogate id dropped; natural composite PK
);

CREATE TABLE ecom_updated.orders (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER NOT NULL REFERENCES ecom_updated.customers(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,    -- widened from NUMERIC(10,2)
    shipping_method VARCHAR(50),                          -- new column
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT orders_status_check                        -- new check constraint
        CHECK (status IN ('pending','paid','shipped','delivered','cancelled'))
);

CREATE TABLE ecom_updated.order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES ecom_updated.orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL
               REFERENCES ecom_updated.products(id) ON DELETE RESTRICT,  -- FK action changed
    quantity   INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL                     -- NARROWED from NUMERIC(12,2)
);

CREATE TABLE ecom_updated.flash_sales (
    id           SERIAL PRIMARY KEY,
    product_id   INTEGER NOT NULL REFERENCES ecom_updated.products(id) ON DELETE CASCADE,
    discount_pct NUMERIC(6,2) NOT NULL,                   -- widened from NUMERIC(5,2)
    sale_period  DATERANGE NOT NULL,                      -- TSTZRANGE → DATERANGE
    -- same constraint name, but its definition changes because sale_period changed type
    CONSTRAINT flash_sales_no_overlap EXCLUDE USING gist (product_id WITH =, sale_period WITH &&)
);

CREATE TABLE ecom_updated.product_reviews (              -- new table (only in ecom_updated)
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES ecom_updated.products(id)  ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES ecom_updated.customers(id) ON DELETE CASCADE,
    rating      INTEGER NOT NULL,
    body        TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT product_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT product_reviews_unique UNIQUE (product_id, customer_id)
);

-- Deploy ledger — IGNORED by the compare engine
CREATE TABLE ecom_updated.script_patch (
    id          SERIAL PRIMARY KEY,
    script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
    version     VARCHAR(20)  NOT NULL,
    title       VARCHAR(150),
    description TEXT,
    change_type VARCHAR(20)  NOT NULL
                  CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
    source_ref  TEXT,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ecom_updated_sp_name_ver_idx ON ecom_updated.script_patch (script_name, version);

-- ─── ecom_updated sample data ───────────────────────────────────────────────
INSERT INTO ecom_updated.categories (name) VALUES ('Electronics'), ('Books');

INSERT INTO ecom_updated.customers (email, customer_name, phone, phone_verified, loyalty_points) VALUES
    ('alice@example.com', 'Alice Chen', '+1-202-555-0101', true,  120),
    ('bob@example.com',   'Bob Smith',  '+1-202-555-0102', false, 0);

INSERT INTO ecom_updated.products (category_id, sku, slug, name, description, price, stock) VALUES
    (1, 'ELEC-001', 'usb-c-charger',         'USB-C Charger',          '65W fast charger', 29.99, 250),
    (2, 'BOOK-001', 'postgres-up-and-running','Postgres Up & Running', 'OReilly title',    39.50, 40);

INSERT INTO ecom_updated.orders (customer_id, status, total, shipping_method) VALUES
    (1, 'paid',    69.49, 'standard'),
    (2, 'pending', 39.50, NULL);

INSERT INTO ecom_updated.script_patch (script_name, version, title, description, change_type, applied_at) VALUES
    ('ecom_schema', '1.0.0', 'Initial e-commerce schema', 'Baseline tables',           'additive', '2025-02-01 09:00:00'),
    ('ecom_schema', '2.0.0', 'Catalog + reviews release', 'Evolve catalog, add reviews','breaking', '2025-05-10 16:00:00');
