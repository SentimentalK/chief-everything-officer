#!/usr/bin/env bash
set -eo pipefail

# Test Stub for CEO Worker Plane
# Simulates Google Agent or worker capability execution

INPUT_FILE=""
OUTPUT_DIR=""
RUN_SCRIPT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input)
            INPUT_FILE="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --run-script)
            RUN_SCRIPT="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

MODE="${TEST_STUB_MODE:-normal}"

if [[ "$MODE" == "direct_run" ]]; then
    # Directly invoke the capability run script
    exec "$RUN_SCRIPT" --input "$INPUT_FILE" --output-dir "$OUTPUT_DIR"
fi

if [[ "$MODE" == "normal" ]]; then
    echo "=== Test Stub Starting ==="
    echo "Simulating worker task for $INPUT_FILE"
    echo "Authorization: Bearer secret_test_token_1234567890"
    
    # Read job_id and attempt_id and url
    JOB_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('job_id'))" "$INPUT_FILE")
    ATTEMPT_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('attempt_id'))" "$INPUT_FILE")
    URL=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('params',{}).get('url',''))" "$INPUT_FILE")

    # Determine mock source_id based on URL
    SOURCE_ID="BV1xx411c7mD"
    SOURCE_TYPE="bilibili"
    if [[ "$URL" == *"youtube"* || "$URL" == *"youtu.be"* ]]; then
        SOURCE_TYPE="youtube"
        SOURCE_ID="dQw4w9WgXcQ"
    fi

    # Write temporary result
    TMP_RES="$OUTPUT_DIR/.${ATTEMPT_ID}_result.json.tmp"
    FINAL_RES="$OUTPUT_DIR/result.json"
    
    cat <<EOF > "$TMP_RES"
{
  "metadata": {
    "source_type": "$SOURCE_TYPE",
    "source_url": "$URL",
    "canonical_url": "$URL",
    "source_id": "$SOURCE_ID",
    "title": "Mock Test Video Title",
    "description": "Mock video description for test",
    "creator": "Mock Creator",
    "published_at": "2024-01-01T00:00:00Z",
    "duration_seconds": 120.0,
    "language": "zh-CN",
    "thumbnail_url": null,
    "media_url": null,
    "view_count": 1000,
    "like_count": 100,
    "comment_count": 10,
    "captured_at": "2026-09-06T15:00:00Z",
    "platform_metadata": null
  },
  "transcript": "这是测试字幕文本内容",
  "transcript_status": "available",
  "transcript_method": "subtitles"
}
EOF

    sync
    mv "$TMP_RES" "$FINAL_RES"

    SIZE=$(wc -c < "$FINAL_RES" | tr -d ' ')
    SHA=$(sha256sum "$FINAL_RES" | awk '{print $1}')

    TMP_COMP="$OUTPUT_DIR/.${ATTEMPT_ID}_completion.json.tmp"
    FINAL_COMP="$OUTPUT_DIR/completion.json"

    cat <<EOF > "$TMP_COMP"
{
  "job_id": "$JOB_ID",
  "attempt_id": "$ATTEMPT_ID",
  "requested_url": "$URL",
  "script_exit_code": 0,
  "artifact": {
    "file_name": "result.json",
    "size_bytes": $SIZE,
    "sha256": "$SHA"
  },
  "business_status": "transcript_available",
  "error": null
}
EOF

    sync
    mv "$TMP_COMP" "$FINAL_COMP"
    echo "=== Test Stub Completed Successfully ==="
    exit 0
fi

if [[ "$MODE" == "script_fail" ]]; then
    echo "=== Test Stub Simulating Script Failure ===" >&2
    JOB_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('job_id'))" "$INPUT_FILE")
    ATTEMPT_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('attempt_id'))" "$INPUT_FILE")
    URL=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('params',{}).get('url',''))" "$INPUT_FILE")

    TMP_COMP="$OUTPUT_DIR/.${ATTEMPT_ID}_completion.json.tmp"
    FINAL_COMP="$OUTPUT_DIR/completion.json"

    cat <<EOF > "$TMP_COMP"
{
  "job_id": "$JOB_ID",
  "attempt_id": "$ATTEMPT_ID",
  "requested_url": "$URL",
  "script_exit_code": 1,
  "artifact": null,
  "business_status": "failed",
  "error": {
    "stage": "extraction",
    "code": "EXTRACTION_NETWORK_ERROR",
    "message": "Connection refused to upstream video server"
  }
}
EOF
    mv "$TMP_COMP" "$FINAL_COMP"
    exit 0
fi

if [[ "$MODE" == "half_write" ]]; then
    echo "=== Test Stub Simulating Half Written File (No completion.json) ==="
    ATTEMPT_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('attempt_id'))" "$INPUT_FILE")
    echo '{"partial": true' > "$OUTPUT_DIR/.${ATTEMPT_ID}_result.json.tmp"
    exit 0
fi

if [[ "$MODE" == "long_lines" ]]; then
    echo "=== Test Stub Outputting Long Lines ==="
    python3 -c "print('A' * 40000)"
    echo "normal line after long line"
    exit 0
fi
