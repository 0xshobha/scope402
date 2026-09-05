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
