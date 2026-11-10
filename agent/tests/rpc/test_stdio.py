"""End-to-end over a real pipe: the packaged entry point, stdin/stdout, JSON lines."""

import json
import os
import subprocess
import sys


def test_backend_process_speaks_json_rpc_on_stdout_only() -> None:
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocol_version": 1}},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run.start",
            "params": {"conversation_id": "c", "text": "ping"},
        },
    ]
    stdin = "".join(json.dumps(r) + "\n" for r in requests)
    env = {**os.environ, "LLM_PROVIDER": "mock", "LOG_LEVEL": "DEBUG"}

    process = subprocess.Popen(
        [sys.executable, "-m", "productivity_agent"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(stdin)
    process.stdin.flush()

    messages = []
    for line in process.stdout:
        message = json.loads(line)
        assert message["jsonrpc"] == "2.0"
        messages.append(message)
        if message.get("params", {}).get("event", {}).get("type") == "done":
            break

    process.stdin.close()  # EOF: the backend shuts down
    assert process.wait(timeout=10) == 0
    assert process.stderr is not None
    assert "starting backend" in process.stderr.read()

    assert messages[0]["result"]["protocol_version"] == 1
    text = "".join(
        m["params"]["event"]["text"]
        for m in messages
        if m.get("params", {}).get("event", {}).get("type") == "text_delta"
    )
    assert text == "(mock) You said: ping"
