# Shared Worker acceptance server start/stop. Source from the three
# acceptance scripts; do not duplicate GitHub App / identity startup env.
#
# Required env:
#   CEO_ACCEPTANCE_SERVER
#   CEO_ACCEPTANCE_ROOT
#   CEO_ACCEPTANCE_KEY
#   CEO_ACCEPTANCE_REDIS
#   CEO_ACCEPTANCE_PORT
#
# Sets SERVER_PID on start.

acceptance_start_server() {
  local srv="${CEO_ACCEPTANCE_SERVER:?missing CEO_ACCEPTANCE_SERVER}"
  local e="${CEO_ACCEPTANCE_ROOT:?missing CEO_ACCEPTANCE_ROOT}"
  local key="${CEO_ACCEPTANCE_KEY:?missing CEO_ACCEPTANCE_KEY}"
  local redis="${CEO_ACCEPTANCE_REDIS:?missing CEO_ACCEPTANCE_REDIS}"
  local port="${CEO_ACCEPTANCE_PORT:?missing CEO_ACCEPTANCE_PORT}"
  local pem="${e}/github-app.pem"
  local log="${e}/logs/server.log"

  mkdir -p "${e}/logs"
  if [ ! -f "$pem" ]; then
    echo "acceptance_start_server: missing GitHub App private key at $pem" >&2
    return 1
  fi

  cd "$srv"
  CEO_DATA_ROOT="$e/data" \
    CEO_BRIDGE_ENABLED=true \
    CEO_REDIS_URL="$redis" \
    PORT="$port" \
    BIND_HOST=127.0.0.1 \
    CEO_GITHUB_APP_ENABLED=true \
    CEO_GITHUB_APP_CLIENT_ID=Iv1.acceptance-test \
    CEO_GITHUB_APP_CLIENT_SECRET=acceptance-test-secret \
    CEO_GITHUB_APP_SLUG=ceo-worker-acceptance \
    CEO_GITHUB_APP_PRIVATE_KEY_PATH="$pem" \
    nohup node dist/server.js > "$log" 2>&1 &
  SERVER_PID=$!

  local started=0
  local i
  for i in $(seq 1 60); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "acceptance_start_server: server process exited during startup" >&2
      cat "$log" >&2 || true
      return 1
    fi
    if curl -sf -H "Authorization: Bearer $key" "http://127.0.0.1:${port}/api/identity" >/dev/null 2>&1; then
      started=1
      break
    fi
    sleep 0.3
  done
  if [ "$started" != 1 ]; then
    echo "acceptance_start_server: server did not become ready" >&2
    cat "$log" >&2 || true
    return 1
  fi
}

acceptance_stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    local i
    for i in $(seq 1 40); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
