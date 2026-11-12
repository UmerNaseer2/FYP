// The trial's three demo databases: one small bookshop at three stages, so
// Compare, Deploy, Drift and the rest have real differences to show.
//
//   prod    : customers.full_name, email varchar(100), orders.status varchar,
//             plus a hand-made "hotfix" index books_title_idx
//   staging : prod without that index, plus books.author, email varchar(255)
//   dev     : staging plus a reviews table, customers.full_name renamed to
//             name, orders.status as an enum, plus index orders_customer_id_idx
//
// Everything sits in the public schema of its own database. Pure: the SQL
// only, which lib/trial-sandbox.ts runs.

export const TRIAL_STAGES = ["prod", "staging", "dev"] as const;
export type TrialStage = (typeof TRIAL_STAGES)[number];

/** One fixed time for every row, so each reset gives the same data. */
const T = "'2026-09-22 03:24:51'";

/** The SQL that builds one stage's bookshop in an empty public schema. */
export function trialSeedSql(stage: TrialStage): string {
  const isProd = stage === "prod";
  const isDev = stage === "dev";
  const nameCol = isDev ? "name" : "full_name";
  const emailLen = isProd ? 100 : 255;
  const statusType = isDev ? "public.order_status" : "varchar(20)";
  const author = (value: string) => (isProd ? "" : `, '${value}'`);

  return `
${isDev ? "CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');" : ""}

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  ${nameCol} varchar(100) NOT NULL,
  email varchar(${emailLen}) NOT NULL UNIQUE,
  created_at timestamp DEFAULT now()
);

CREATE TABLE public.books (
  id serial PRIMARY KEY,
  title varchar(200) NOT NULL,
  price numeric NOT NULL,
  stock integer NOT NULL DEFAULT 0${isProd ? "" : ",\n  author varchar(100)"}
);

CREATE TABLE public.orders (
  id serial PRIMARY KEY,
  customer_id integer REFERENCES public.customers(id),
  ordered_at timestamp DEFAULT now(),
  status ${statusType} DEFAULT 'pending'
);

CREATE TABLE public.order_items (
  order_id integer NOT NULL REFERENCES public.orders(id),
  book_id integer NOT NULL REFERENCES public.books(id),
  quantity integer NOT NULL,
  PRIMARY KEY (order_id, book_id)
);

${
  isDev
    ? `CREATE TABLE public.reviews (
  id serial PRIMARY KEY,
  book_id integer NOT NULL REFERENCES public.books(id),
  customer_id integer NOT NULL REFERENCES public.customers(id),
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text
);`
    : ""
}

${isProd ? "CREATE INDEX books_title_idx ON public.books (title);" : ""}
${isDev ? "CREATE INDEX orders_customer_id_idx ON public.orders (customer_id);" : ""}

INSERT INTO public.customers (id, ${nameCol}, email, created_at) VALUES
  (1, 'Aisha Rahman', 'aisha@example.com', ${T}),
  (2, 'Ben Lee', 'ben@example.com', ${T}),
  (3, 'Chen Wei', 'chen@example.com', ${T});

INSERT INTO public.books (id, title, price, stock${isProd ? "" : ", author"}) VALUES
  (1, 'Clean Code', 45.00, 10${author("Robert C. Martin")}),
  (2, 'The Pragmatic Programmer', 50.00, 5${author("Hunt & Thomas")}),
  (3, 'Designing Data-Intensive Applications', 65.00, 3${author("Martin Kleppmann")}),
  (4, 'Refactoring', 48.00, 0${author("Martin Fowler")}),
  (5, 'SQL Performance Explained', 35.00, 7${author("Markus Winand")});

INSERT INTO public.orders (id, customer_id, ordered_at, status) VALUES
  (1, 1, ${T}, 'paid'),
  (2, 1, ${T}, 'shipped'),
  (3, 2, ${T}, 'pending'),
  (4, 3, ${T}, 'cancelled');

INSERT INTO public.order_items (order_id, book_id, quantity) VALUES
  (1, 1, 1), (1, 3, 1), (2, 2, 2), (3, 5, 1), (4, 4, 1);

${
  isDev
    ? `INSERT INTO public.reviews (id, book_id, customer_id, rating, comment) VALUES
  (1, 1, 1, 5, 'Changed how I name things.'),
  (2, 3, 1, 4, 'Dense but worth it.'),
  (3, 2, 2, 3, NULL);`
    : ""
}

SELECT setval(pg_get_serial_sequence('public.customers', 'id'), 3);
SELECT setval(pg_get_serial_sequence('public.books', 'id'), 5);
SELECT setval(pg_get_serial_sequence('public.orders', 'id'), 4);
${isDev ? "SELECT setval(pg_get_serial_sequence('public.reviews', 'id'), 3);" : ""}
`;
}
