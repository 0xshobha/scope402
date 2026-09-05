import { Pool, type PoolClient } from 'pg'

declare const transactionClient: unique symbol
export type TransactionClient = PoolClient & { readonly [transactionClient]: true }

let pool: Pool | undefined

export function database() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('Set DATABASE_URL for durable payment state')
  if (!pool) {
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 })
    pool.on('error', (error) => console.error(`Idle database connection failed: ${error.message}`))
  }
  return pool
}

export async function initializeDatabase() {
  await database().query(`
    CREATE TABLE IF NOT EXISTS payment_quotes (
      quote_id uuid PRIMARY KEY,
      repo_url text NOT NULL,
      subject_pubkey text NOT NULL,
      resource_url text NOT NULL,
      requirements jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS repository_name text;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS commit_sha text;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS root_files jsonb;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS files_considered integer;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS pricing jsonb;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS scope402_extension jsonb;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS policy_hash text;
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS merchant_id text NOT NULL DEFAULT 'auditlab';
    ALTER TABLE payment_quotes ADD COLUMN IF NOT EXISTS request_binding jsonb;
    ALTER TABLE payment_quotes ALTER COLUMN repo_url DROP NOT NULL;
    CREATE TABLE IF NOT EXISTS payment_redemptions (
      transaction_id text PRIMARY KEY,
      quote_id uuid NOT NULL UNIQUE REFERENCES payment_quotes(quote_id),
      status text NOT NULL CHECK (status IN (
        'verifying', 'settlement_attempted', 'settled', 'settlement_failed', 'settlement_unknown'
      )),
      payer text,
      receipt jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS scan_jobs (
      transaction_id text PRIMARY KEY REFERENCES payment_redemptions(transaction_id),
      quote_id uuid NOT NULL UNIQUE REFERENCES payment_quotes(quote_id),
      status text NOT NULL CHECK (status IN ('pending', 'running', 'retryable_failed', 'complete')),
      scan_result jsonb,
      lease_id uuid,
      lease_token text,
      last_error text,
      run_started_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tessera_slots (
      canvas_id text NOT NULL,
      slot integer NOT NULL CHECK (slot >= 0 AND slot < 16),
      quote_id uuid UNIQUE REFERENCES payment_quotes(quote_id),
      status text NOT NULL CHECK (status IN ('available', 'pending', 'allocated')),
      reservation_expires_at timestamptz,
      transaction_id text UNIQUE,
      PRIMARY KEY (canvas_id, slot),
      CHECK (
        (status = 'available' AND quote_id IS NULL AND reservation_expires_at IS NULL AND transaction_id IS NULL) OR
        (status = 'pending' AND quote_id IS NOT NULL AND reservation_expires_at IS NOT NULL AND transaction_id IS NULL) OR
        (status = 'allocated' AND quote_id IS NOT NULL AND reservation_expires_at IS NULL AND transaction_id IS NOT NULL)
      )
    );
    INSERT INTO tessera_slots (canvas_id, slot, status)
    SELECT 'main', slot, 'available' FROM generate_series(0, 15) AS slot
    ON CONFLICT (canvas_id, slot) DO NOTHING;
    CREATE TABLE IF NOT EXISTS plot_jobs (
      transaction_id text PRIMARY KEY REFERENCES payment_redemptions(transaction_id),
      quote_id uuid NOT NULL UNIQUE REFERENCES payment_quotes(quote_id),
      status text NOT NULL CHECK (status IN ('pending', 'running', 'retryable_failed', 'complete')),
      result jsonb,
      lease_id uuid,
      lease_token text,
      last_error text,
      run_started_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tool_leases (
      lease_id uuid PRIMARY KEY,
      subject_pubkey text NOT NULL,
      scan_id uuid NOT NULL,
      hedera_tx_id text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      max_calls integer NOT NULL CHECK (max_calls > 0),
      used_calls integer NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
      last_counter integer NOT NULL DEFAULT 0 CHECK (last_counter >= 0),
      revoked_at timestamptz,
      policy_hash text,
      findings jsonb NOT NULL
    );
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS policy_hash text;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS resource jsonb;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS audience text;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS catalogue_hash text;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS tool_ids jsonb;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS format_version smallint
      CHECK (format_version IS NULL OR format_version IN (1, 2));
    ALTER TABLE tool_leases DROP CONSTRAINT IF EXISTS tool_leases_format_version_check;
    ALTER TABLE tool_leases ADD CONSTRAINT tool_leases_format_version_check
      CHECK (format_version IS NULL OR format_version IN (1, 2));
    ALTER TABLE tool_leases ALTER COLUMN scan_id DROP NOT NULL;
    ALTER TABLE tool_leases ALTER COLUMN findings SET DEFAULT '[]'::jsonb;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS payment_quote_id uuid REFERENCES payment_quotes(quote_id);
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS merchant_id text;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS parent_lease_id uuid REFERENCES tool_leases(lease_id);
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS root_lease_id uuid REFERENCES tool_leases(lease_id);
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS reserved_calls integer NOT NULL DEFAULT 0;
    ALTER TABLE tool_leases ADD COLUMN IF NOT EXISTS last_delegation_counter integer NOT NULL DEFAULT 0;
    ALTER TABLE tool_leases DROP CONSTRAINT IF EXISTS tool_leases_hedera_tx_id_key;
    ALTER TABLE tool_leases DROP CONSTRAINT IF EXISTS tool_leases_reserved_calls_check;
    ALTER TABLE tool_leases ADD CONSTRAINT tool_leases_reserved_calls_check
      CHECK (reserved_calls >= 0 AND used_calls + reserved_calls <= max_calls);
    ALTER TABLE tool_leases DROP CONSTRAINT IF EXISTS tool_leases_last_delegation_counter_check;
    ALTER TABLE tool_leases ADD CONSTRAINT tool_leases_last_delegation_counter_check
      CHECK (last_delegation_counter >= 0);
    CREATE UNIQUE INDEX IF NOT EXISTS tool_leases_root_hedera_tx_id_key
      ON tool_leases (hedera_tx_id) WHERE parent_lease_id IS NULL;
    CREATE TABLE IF NOT EXISTS tessera_pixels (
      canvas_id text NOT NULL CHECK (canvas_id = 'main'),
      x integer NOT NULL CHECK (x >= 0 AND x < 32),
      y integer NOT NULL CHECK (y >= 0 AND y < 32),
      color text NOT NULL CHECK (color IN (
        '#0B0B0C', '#F5F2EA', '#FFFFFF', '#FFB020',
        '#7C4DFF', '#00D3F2', '#C6F432', '#FF3B30'
      )),
      lease_id uuid NOT NULL REFERENCES tool_leases(lease_id),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (canvas_id, x, y)
    );
  `)
}

export async function closeDatabase() {
  await pool?.end()
  pool = undefined
}

export async function transaction<T>(run: (client: TransactionClient) => Promise<T>) {
  const client = await database().connect()
  try {
    await client.query('BEGIN')
    const result = await run(client as TransactionClient)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
