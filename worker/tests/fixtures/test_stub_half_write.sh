#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TEST_STUB_MODE=half_write
exec "$SCRIPT_DIR/test_stub.sh" "$@"
