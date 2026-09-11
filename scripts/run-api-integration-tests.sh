#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${DATABASE_URL:-}" ]]; then
  exec corepack pnpm --filter @scope402/api exec tsx --test --test-concurrency=1 'test/*.integration.test.ts'
fi

readonly port="${SCOPE402_TEST_POSTGRES_PORT:-55432}"
readonly default_container="scope402-postgres-test"
container="$(docker ps --filter "publish=${port}" --format '{{.Names}}' | head -n 1)"

if [[ -z "$container" ]]; then
  if docker container inspect "$default_container" >/dev/null 2>&1; then
    docker start "$default_container" >/dev/null
    container="$default_container"
  else
    docker run --detach --name "$default_container" \
      --publish "127.0.0.1:${port}:5432" \
      --env POSTGRES_USER=scope402 \
      --env POSTGRES_PASSWORD=scope402-test-only \
      --env POSTGRES_DB=scope402_test \
      postgres:17-alpine >/dev/null
    container="$default_container"
  fi
fi

read_container_env() {
  local name="$1"
  docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n "s/^${name}=//p" | tail -n 1
}

readonly user="$(read_container_env POSTGRES_USER)"
readonly password="$(read_container_env POSTGRES_PASSWORD)"
readonly database="$(read_container_env POSTGRES_DB)"

if [[ -z "$user" || -z "$password" || -z "$database" ]]; then
  echo "The PostgreSQL container on port ${port} does not expose the expected test credentials." >&2
  exit 1
fi

for _ in {1..30}; do
  if docker exec "$container" pg_isready --username "$user" --dbname "$database" >/dev/null 2>&1; then
    export DATABASE_URL="postgresql://${user}:${password}@127.0.0.1:${port}/${database}"
    exec corepack pnpm --filter @scope402/api exec tsx --test --test-concurrency=1 'test/*.integration.test.ts'
  fi
  sleep 1
done

echo "PostgreSQL test database did not become ready on port ${port}." >&2
exit 1
