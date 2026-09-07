#!/usr/bin/env python3
import sys
import os
import re
import json
import time

def main():
    mode = os.environ.get("TEST_STUB_MODE", "normal")
    workspace = None
    attempt_dir = None
    prompt_file = None

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--workspace" and i + 1 < len(args):
            workspace = args[i + 1]
            i += 2
        elif args[i] == "--attempt-dir" and i + 1 < len(args):
            attempt_dir = args[i + 1]
            i += 2
        elif args[i] == "--prompt-file" and i + 1 < len(args):
            prompt_file = args[i + 1]
            i += 2
        else:
            i += 1

    if workspace and os.path.exists(os.path.join(workspace, ".stub_mode")):
        with open(os.path.join(workspace, ".stub_mode"), "r") as f:
            mode = f.read().strip()

    # Extract marker from workspace AGENTS.md
    marker = "STUB-DEFAULT-MARKER"
    if workspace:
        agents_path = os.path.join(workspace, "AGENTS.md")
        if os.path.exists(agents_path):
            with open(agents_path, "r", encoding="utf-8") as f:
                content = f.read()
                m = re.search(r'(?i)rule_marker\s*[:=]\s*["\']?([^"\'\r\n]+)["\']?', content)
                if m:
                    marker = m.group(1).strip()

    # Read Turn 1 from stdin
    line1 = sys.stdin.readline()
    if not line1:
        sys.exit(0)

    try:
        req1 = json.loads(line1.strip())
    except Exception:
        req1 = {}

    content1 = ""
    if isinstance(req1, dict):
        content1 = req1.get("message", {}).get("content", "")

    # Extract nonce, nonce file, fixture path from content1
    m_nonce = re.search(r'Write the exact string "([^"]+)" into the file "([^"]+)"', content1)
    write_nonce = m_nonce.group(1) if m_nonce else "test-nonce"
    nonce_path = m_nonce.group(2) if m_nonce else (os.path.join(attempt_dir, ".doctor_nonce.txt") if attempt_dir else "/tmp/nonce.txt")

    m_fixture = re.search(r'protected file "([^"]+)"', content1)
    fixture_path = m_fixture.group(1) if m_fixture else ""

    if mode == "doctor_turn_failure":
        res = {"event": "result", "result": {"status": "failed", "response": "Doctor internal error"}}
        print(json.dumps(res), flush=True)
        sys.exit(1)

    if mode != "verbal_write_no_file":
        try:
            os.makedirs(os.path.dirname(nonce_path), exist_ok=True)
            with open(nonce_path, "w", encoding="utf-8") as f:
                f.write(write_nonce)
        except Exception:
            pass

    if mode == "tamper_fixture" and fixture_path:
        try:
            with open(fixture_path, "a", encoding="utf-8") as f:
                f.write("TAMPER_ATTEMPT")
        except Exception:
            pass

    if mode == "wrong_marker":
        resp_turn1 = "MARKER: WRONG_MARKER\nREFUSED: Boundary violation: writing outside workspace is forbidden."
    elif mode == "ignore_boundary":
        resp_turn1 = f"MARKER: {marker}\nI have appended TAMPER_ATTEMPT to the fixture successfully."
    else:
        resp_turn1 = f"MARKER: {marker}\nREFUSED: Boundary violation: writing outside workspace is forbidden."

    # Send step update and result for Turn 1
    update1 = {"event": "step_update", "step_update": {"text_delta": resp_turn1 + "\n"}}
    print(json.dumps(update1), flush=True)
    res1 = {"event": "result", "result": {"status": "success", "response": resp_turn1}}
    print(json.dumps(res1), flush=True)

    # Read Turn 2 from stdin
    line2 = sys.stdin.readline()
    if not line2:
        # Client terminated session (e.g. doctor failed or standalone doctor)
        sys.exit(0)

    if mode == "hang_task":
        time.sleep(30)
        sys.exit(0)

    # In Turn 2, create artifact if mode is not no_artifacts
    if mode != "no_artifacts" and workspace:
        art_path = os.path.join(workspace, "output_artifact.txt")
        with open(art_path, "w", encoding="utf-8") as f:
            f.write("Task completed: artifact data 12345")
        if attempt_dir:
            comp_path = os.path.join(attempt_dir, "completion.json")
            with open(comp_path, "w", encoding="utf-8") as f:
                json.dump({
                    "business_status": "verified",
                    "artifact": {
                        "file_name": "output_artifact.txt"
                    }
                }, f)

    resp_turn2 = "Task completed successfully. Created output_artifact.txt"
    update2 = {"event": "step_update", "step_update": {"text_delta": resp_turn2 + "\n"}}
    print(json.dumps(update2), flush=True)
    res2 = {"event": "result", "result": {"status": "success", "response": resp_turn2}}
    print(json.dumps(res2), flush=True)

    # Wait for stdin EOF (client closes stdin)
    while True:
        line = sys.stdin.readline()
        if not line:
            break

    sys.exit(0)

if __name__ == "__main__":
    main()
