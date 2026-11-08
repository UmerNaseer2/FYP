-- Rows for the AI benchmark's migration review cases.
--
-- The review reads each table's size from the target and judges locks and
-- rewrites by it, so against empty tables "safe" is often the right answer and
-- the cases test nothing. This fills the Bookshop test database's dev schema
-- with made-up rows of realistic size: about 500,000 orders and 1,000,000
-- order lines. Test databases only. It empties the dev tables first.
--
--   psql -d shop -f scripts/ai-bench-rows.sql
--
-- To empty them again afterwards:
--   TRUNCATE dev.order_items, dev.reviews, dev.orders, dev.books,
--            dev.customers, dev.authors RESTART IDENTITY;

BEGIN;

TRUNCATE dev.order_items, dev.reviews, dev.orders, dev.books, dev.customers, dev.authors
  RESTART IDENTITY;

INSERT INTO dev.authors (name, country, bio)
SELECT 'Author ' || g,
       (ARRAY['AU', 'NZ', 'GB', 'US', 'IN', NULL])[1 + g % 6],
       CASE WHEN g % 3 = 0 THEN NULL ELSE 'Writes books, number ' || g END
FROM generate_series(1, 2000) AS g;

-- Some titles are longer than 20 characters and some isbn values are missing,
-- so narrowing a type or adding NOT NULL has rows to fail on. The isbn values
-- that are there are all different, so making isbn unique can work; authors'
-- countries repeat, so making country unique cannot.
INSERT INTO dev.books (title, author_id, price, published, stock, isbn)
SELECT CASE WHEN g % 4 = 0 THEN 'A rather long book title, volume ' || g ELSE 'Book ' || g END,
       1 + g % 2000,
       round((5 + (g % 9500) / 100.0)::numeric, 2),
       date '1990-01-01' + (g % 12000),
       g % 50,
       CASE WHEN g % 10 = 0 THEN NULL ELSE '978' || lpad(g::text, 10, '0') END
FROM generate_series(1, 50000) AS g;

INSERT INTO dev.customers (email, full_name, phone)
SELECT 'customer' || g || '@example.com',
       'Customer ' || g,
       CASE WHEN g % 5 = 0 THEN NULL ELSE '04' || lpad((g % 100000000)::text, 8, '0') END
FROM generate_series(1, 100000) AS g;

INSERT INTO dev.orders (customer_id, placed_at, total, status)
SELECT 1 + g % 100000,
       timestamptz '2024-01-01' + (g % 60000) * interval '10 minutes',
       round((10 + (g % 40000) / 100.0)::numeric, 2),
       (ARRAY['new', 'paid', 'shipped', 'delivered', 'cancelled'])[1 + g % 5]
FROM generate_series(1, 500000) AS g;

INSERT INTO dev.order_items (order_id, book_id, qty)
SELECT 1 + (g - 1) / 2, 1 + (g::bigint * 7919) % 50000, 1 + g % 3
FROM generate_series(1, 1000000) AS g;

INSERT INTO dev.reviews (book_id, rating, body)
SELECT 1 + (g * 31) % 50000,
       1 + g % 5,
       CASE WHEN g % 2 = 0 THEN NULL ELSE 'Review text ' || g END
FROM generate_series(1, 80000) AS g;

COMMIT;

ANALYZE dev.authors, dev.books, dev.customers, dev.orders, dev.order_items, dev.reviews;
