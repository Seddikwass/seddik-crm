-- SEDDIK CRM — schéma de base de données (multi-entreprises)

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text,
  price_month numeric(12,3) NOT NULL,
  price_year numeric(12,3) NOT NULL,
  max_users int NOT NULL DEFAULT 1,
  features jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS companies (
  id serial PRIMARY KEY,
  name text NOT NULL,
  legal_form text,
  tax_id text,
  rc text,
  address text,
  city text,
  phone text,
  email text,
  website text,
  bank_name text,
  rib text,
  invoice_footer text,
  currency text NOT NULL DEFAULT 'TND',
  timbre numeric(12,3) NOT NULL DEFAULT 1.000,
  default_terms int NOT NULL DEFAULT 30,
  prefixes jsonb NOT NULL DEFAULT '{}',
  accounts_map jsonb NOT NULL DEFAULT '{}',
  plan_code text NOT NULL DEFAULT 'pro',
  status text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  paid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  company_id int REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  active boolean NOT NULL DEFAULT true,
  last_login timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  months int NOT NULL,
  amount numeric(12,3) NOT NULL,
  method text NOT NULL,
  reference text,
  note text,
  status text NOT NULL DEFAULT 'pending',
  provider_ref text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processed_by int
);

CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  tax_id text,
  address text,
  city text,
  phone text,
  whatsapp text,
  email text,
  contact text,
  terms int NOT NULL DEFAULT 30,
  credit_limit numeric(14,3) NOT NULL DEFAULT 0,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  tax_id text,
  address text,
  city text,
  phone text,
  whatsapp text,
  email text,
  contact text,
  terms int NOT NULL DEFAULT 30,
  credit_limit numeric(14,3) NOT NULL DEFAULT 0,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  family text,
  unit text NOT NULL DEFAULT 'U',
  kind text NOT NULL DEFAULT 'stock',
  sale_price numeric(14,3) NOT NULL DEFAULT 0,
  purchase_price numeric(14,3) NOT NULL DEFAULT 0,
  avg_cost numeric(14,3) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 19,
  stock numeric(14,3) NOT NULL DEFAULT 0,
  min_stock numeric(14,3) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS documents (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side text NOT NULL,
  type text NOT NULL,
  number text,
  date date NOT NULL DEFAULT current_date,
  due_date date,
  customer_id int REFERENCES customers(id),
  supplier_id int REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'brouillon',
  ext_ref text,
  notes text,
  return_stock boolean NOT NULL DEFAULT false,
  total_ht numeric(14,3) NOT NULL DEFAULT 0,
  total_tva numeric(14,3) NOT NULL DEFAULT 0,
  timbre numeric(14,3) NOT NULL DEFAULT 0,
  total_ttc numeric(14,3) NOT NULL DEFAULT 0,
  paid numeric(14,3) NOT NULL DEFAULT 0,
  source_id int REFERENCES documents(id) ON DELETE SET NULL,
  stock_done boolean NOT NULL DEFAULT false,
  created_by int,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz
);
CREATE INDEX IF NOT EXISTS documents_list_idx ON documents (company_id, side, type, date DESC);
CREATE INDEX IF NOT EXISTS documents_customer_idx ON documents (company_id, customer_id);
CREATE INDEX IF NOT EXISTS documents_supplier_idx ON documents (company_id, supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_number_uq ON documents (company_id, side, type, number) WHERE number IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_lines (
  id serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  product_id int REFERENCES products(id),
  description text NOT NULL DEFAULT '',
  qty numeric(14,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,3) NOT NULL DEFAULT 0,
  discount numeric(5,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 19,
  total_ht numeric(14,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS document_lines_doc_idx ON document_lines (document_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  date date NOT NULL DEFAULT current_date,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,3) NOT NULL DEFAULT 0,
  kind text NOT NULL,
  ref text,
  document_id int REFERENCES documents(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_idx ON stock_moves (company_id, product_id, date DESC);

CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side text NOT NULL,
  customer_id int REFERENCES customers(id),
  supplier_id int REFERENCES suppliers(id),
  number text,
  date date NOT NULL DEFAULT current_date,
  amount numeric(14,3) NOT NULL,
  withholding numeric(14,3) NOT NULL DEFAULT 0,
  method text NOT NULL,
  reference text,
  bank text,
  due_date date,
  status text NOT NULL DEFAULT 'valide',
  note text,
  created_by int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_idx ON payments (company_id, side, date DESC);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id serial PRIMARY KEY,
  payment_id int NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  document_id int NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount numeric(14,3) NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_allocations_doc_idx ON payment_allocations (document_id);

CREATE TABLE IF NOT EXISTS reminders (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id int NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  document_id int REFERENCES documents(id) ON DELETE SET NULL,
  date date NOT NULL DEFAULT current_date,
  channel text NOT NULL,
  level int NOT NULL DEFAULT 1,
  note text,
  promise_date date,
  promise_amount numeric(14,3),
  next_date date,
  done boolean NOT NULL DEFAULT false,
  created_by int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_idx ON reminders (company_id, customer_id, date DESC);

CREATE TABLE IF NOT EXISTS accounts (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS entries (
  id serial PRIMARY KEY,
  company_id int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal text NOT NULL,
  number text,
  date date NOT NULL,
  label text NOT NULL,
  ref text,
  source text,
  source_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entries_idx ON entries (company_id, journal, date DESC);

CREATE TABLE IF NOT EXISTS entry_lines (
  id serial PRIMARY KEY,
  entry_id int NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  company_id int NOT NULL,
  account text NOT NULL,
  partner_kind text,
  partner_id int,
  label text,
  debit numeric(14,3) NOT NULL DEFAULT 0,
  credit numeric(14,3) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entry_lines_account_idx ON entry_lines (company_id, account);

CREATE TABLE IF NOT EXISTS counters (
  company_id int NOT NULL,
  key text NOT NULL,
  year int NOT NULL,
  value int NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, key, year)
);
