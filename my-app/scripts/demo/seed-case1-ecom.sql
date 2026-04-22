-- =============================================================================
-- DEMO CASE 1: E-COMMERCE  (ecom_v1  vs  ecom_v2)
-- =============================================================================
-- What the comparison algorithm will detect:
--   TABLE RENAMES  : users → customers  |  order_items → purchase_lines
--   COLUMN RENAME  : orders.user_id → orders.customer_id
--   TYPE CHANGE    : price / total_amount / unit_price  NUMERIC(10,2) → NUMERIC(12,2)
--   NEW COLUMNS    : customers.phone  |  products.discount_pct
--   NEW TABLE      : payments  (only in v2)
--   NO CHANGES     : categories  (identical in both versions)
-- =============================================================================

-- ── Cleanup (safe to re-run) ──────────────────────────────────────────────────
DROP SCHEMA IF EXISTS ecom_v1 CASCADE;
DROP SCHEMA IF EXISTS ecom_v2 CASCADE;


-- ══════════════════════════════════════════════════════════════════════════════
--  V1  –  original schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA ecom_v1;

CREATE TABLE ecom_v1.users (
    id         SERIAL,
    email      VARCHAR(255) NOT NULL,
    full_name  VARCHAR(255) NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT pk_users      PRIMARY KEY (id),
    CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE TABLE ecom_v1.categories (
    id          SERIAL,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    CONSTRAINT pk_categories      PRIMARY KEY (id),
    CONSTRAINT uq_categories_name UNIQUE (name)
);

CREATE TABLE ecom_v1.products (
    id          SERIAL,
    name        VARCHAR(255)  NOT NULL,
    price       NUMERIC(10,2) NOT NULL,
    stock_qty   INTEGER       NOT NULL DEFAULT 0,
    category_id INTEGER       NOT NULL,
    created_at  TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_products          PRIMARY KEY (id),
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES ecom_v1.categories(id)
);

CREATE TABLE ecom_v1.orders (
    id           SERIAL,
    user_id      INTEGER       NOT NULL,
    status       VARCHAR(50)   NOT NULL DEFAULT 'pending',
    total_amount NUMERIC(10,2) NOT NULL,
    placed_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_orders      PRIMARY KEY (id),
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES ecom_v1.users(id)
);

CREATE TABLE ecom_v1.order_items (
    id         SERIAL,
    order_id   INTEGER       NOT NULL,
    product_id INTEGER       NOT NULL,
    quantity   INTEGER       NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL,
    CONSTRAINT pk_order_items          PRIMARY KEY (id),
    CONSTRAINT fk_order_items_order    FOREIGN KEY (order_id)   REFERENCES ecom_v1.orders(id),
    CONSTRAINT fk_order_items_product  FOREIGN KEY (product_id) REFERENCES ecom_v1.products(id)
);


-- ══════════════════════════════════════════════════════════════════════════════
--  V2  –  evolved schema
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA ecom_v2;

-- "users" renamed to "customers" + new column: phone
CREATE TABLE ecom_v2.customers (
    id         SERIAL,
    email      VARCHAR(255) NOT NULL,
    full_name  VARCHAR(255) NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    phone      VARCHAR(20),                          -- NEW column
    CONSTRAINT pk_customers       PRIMARY KEY (id),
    CONSTRAINT uq_customers_email UNIQUE (email)
);

-- categories: identical — algo should report "no changes"
CREATE TABLE ecom_v2.categories (
    id          SERIAL,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    CONSTRAINT pk_categories      PRIMARY KEY (id),
    CONSTRAINT uq_categories_name UNIQUE (name)
);

-- products: price type widened NUMERIC(10,2) → NUMERIC(12,2)
--           new column: discount_pct
CREATE TABLE ecom_v2.products (
    id           SERIAL,
    name         VARCHAR(255)  NOT NULL,
    price        NUMERIC(12,2) NOT NULL,             -- TYPE CHANGED
    stock_qty    INTEGER       NOT NULL DEFAULT 0,
    category_id  INTEGER       NOT NULL,
    created_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
    discount_pct NUMERIC(5,2)  DEFAULT 0.00,         -- NEW column
    CONSTRAINT pk_products          PRIMARY KEY (id),
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES ecom_v2.categories(id)
);

-- orders: column renamed user_id → customer_id, FK updated, amount type widened
CREATE TABLE ecom_v2.orders (
    id           SERIAL,
    customer_id  INTEGER       NOT NULL,             -- RENAMED from user_id
    status       VARCHAR(50)   NOT NULL DEFAULT 'pending',
    total_amount NUMERIC(12,2) NOT NULL,             -- TYPE CHANGED
    placed_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_orders          PRIMARY KEY (id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES ecom_v2.customers(id)
);

-- "order_items" renamed to "purchase_lines", types widened to match
CREATE TABLE ecom_v2.purchase_lines (
    id         SERIAL,
    order_id   INTEGER       NOT NULL,
    product_id INTEGER       NOT NULL,
    quantity   INTEGER       NOT NULL,
    unit_price NUMERIC(12,2) NOT NULL,              -- TYPE CHANGED
    CONSTRAINT pk_purchase_lines          PRIMARY KEY (id),
    CONSTRAINT fk_purchase_lines_order    FOREIGN KEY (order_id)   REFERENCES ecom_v2.orders(id),
    CONSTRAINT fk_purchase_lines_product  FOREIGN KEY (product_id) REFERENCES ecom_v2.products(id)
);

-- payments: completely new table, only exists in v2
CREATE TABLE ecom_v2.payments (
    id       SERIAL,
    order_id INTEGER       NOT NULL,
    method   VARCHAR(50)   NOT NULL,
    amount   NUMERIC(12,2) NOT NULL,
    paid_at  TIMESTAMP     NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_payments       PRIMARY KEY (id),
    CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES ecom_v2.orders(id)
);


-- ── Verification query ────────────────────────────────────────────────────────
-- Run this after the script to confirm all tables were created:
SELECT schemaname, tablename
FROM   pg_tables
WHERE  schemaname IN ('ecom_v1', 'ecom_v2')
ORDER  BY schemaname, tablename;
