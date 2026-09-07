"""
Unit and integration tests for logging subsystem, probe filtering, and request correlation.
"""

import json
import logging
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from url_resolver.models import ContentMetadataV1, Diagnostics, ResolutionOutcome
from url_resolver.service import (
    ProbeEndpointFilter,
    app,
    extract_or_generate_request_id,
    sanitize_url,
)

client = TestClient(app)
VALID_TOKEN = "logging-test-token-123456"


class TestLoggingSubsystem(unittest.TestCase):
    def test_probe_filter_silences_200(self):
        """Verify ProbeEndpointFilter suppresses 200 OK for /healthz and /readyz."""
        filter_obj = ProbeEndpointFilter()

        rec_health = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "GET", "/healthz", "1.1", 200),
            exc_info=None,
        )
        self.assertFalse(filter_obj.filter(rec_health))

        rec_ready = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "GET", "/readyz", "1.1", 200),
            exc_info=None,
        )
        self.assertFalse(filter_obj.filter(rec_ready))

    def test_probe_filter_preserves_errors_and_redirects(self):
        """Verify ProbeEndpointFilter preserves 503, 500, 301 on probe endpoints."""
        filter_obj = ProbeEndpointFilter()

        rec_503 = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "GET", "/readyz", "1.1", 503),
            exc_info=None,
        )
        self.assertTrue(filter_obj.filter(rec_503))

        rec_500 = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "GET", "/healthz", "1.1", 500),
            exc_info=None,
        )
        self.assertTrue(filter_obj.filter(rec_500))

        rec_301 = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "GET", "/healthz", "1.1", 301),
            exc_info=None,
        )
        self.assertTrue(filter_obj.filter(rec_301))

    def test_probe_filter_preserves_non_probe_endpoints(self):
        """Verify ProbeEndpointFilter preserves /v1/resolve requests."""
        filter_obj = ProbeEndpointFilter()

        rec_resolve = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1:1234", "POST", "/v1/resolve", "1.1", 200),
            exc_info=None,
        )
        self.assertTrue(filter_obj.filter(rec_resolve))

    def test_sanitize_url(self):
        """Verify sanitize_url strips userinfo and sensitive query params."""
        raw = "https://user:secretpass@example.com/video/123?token=abc123secret&normal_param=visible&sig=999"
        cleaned = sanitize_url(raw)
        self.assertNotIn("secretpass", cleaned)
        self.assertNotIn("user:", cleaned)
        self.assertNotIn("abc123secret", cleaned)
        self.assertIn("normal_param=visible", cleaned)
        self.assertIn("token=[REDACTED]", cleaned)
        self.assertIn("sig=[REDACTED]", cleaned)

    def test_extract_or_generate_request_id(self):
        """Verify X-Request-ID validation and generation."""
        mock_req = MagicMock()
        mock_req.headers = {"x-request-id": "client-trace-id-12345"}
        self.assertEqual(extract_or_generate_request_id(mock_req), "client-trace-id-12345")

        # Invalid chars generate UUID
        mock_req.headers = {"x-request-id": "invalid; header \n injection"}
        gen_id = extract_or_generate_request_id(mock_req)
        self.assertNotEqual(gen_id, mock_req.headers["x-request-id"])
        self.assertEqual(len(gen_id), 36)

    def test_resolve_complete_structured_logging(self):
        """Verify /v1/resolve emits single-line JSON log with all required fields on success."""
        mock_outcome = ResolutionOutcome(
            status="resolved",
            fields_resolved=["title", "creator", "duration_seconds"],
            metadata=ContentMetadataV1(
                schema_version=1,
                source_type="youtube",
                source_id="dQw4w9WgXcQ",
                source_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                title="Rick Astley - Never Gonna Give You Up",
                creator="Rick Astley",
                duration_seconds=214,
            ),
            diagnostics=Diagnostics(
                strategy="generic_static",
                fetch_status="ok",
                http_status=200,
                code=None,
            ),
        )

        with patch("url_resolver.service.resolve_url", return_value=mock_outcome), \
             patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}), \
             patch("url_resolver.service.log_structured_event") as mock_log:

            resp = client.post(
                "/v1/resolve",
                headers={"Authorization": f"Bearer {VALID_TOKEN}", "X-Request-ID": "test-req-001"},
                json={"schema_version": 1, "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            )

            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("X-Request-ID"), "test-req-001")

            mock_log.assert_called_once()
            level, payload = mock_log.call_args[0]
            self.assertEqual(level, logging.INFO)
            self.assertEqual(payload["event"], "resolve_complete")
            self.assertEqual(payload["request_id"], "test-req-001")
            self.assertEqual(payload["http_status"], 200)
            self.assertEqual(payload["resolution_status"], "resolved")
            self.assertEqual(payload["strategy"], "generic_static")
            self.assertEqual(payload["upstream_http_status"], 200)
            self.assertIn("latency_ms", payload)
            self.assertEqual(payload["title"], "Rick Astley - Never Gonna Give You Up")
            self.assertEqual(payload["creator"], "Rick Astley")

    def test_resolve_unavailable_structured_logging(self):
        """Verify unavailable resolve disambiguates http_status (200) vs upstream_http_status (412)."""
        mock_outcome = ResolutionOutcome(
            status="unavailable",
            fields_resolved=[],
            metadata=ContentMetadataV1(
                schema_version=1,
                source_type="bilibili",
                source_id="BV1xx411c7mD",
                source_url="https://www.bilibili.com/video/BV1xx411c7mD",
            ),
            diagnostics=Diagnostics(
                strategy="generic_static",
                fetch_status="blocked",
                http_status=412,
                code="ACCESS_BLOCKED",
            ),
        )

        with patch("url_resolver.service.resolve_url", return_value=mock_outcome), \
             patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}), \
             patch("url_resolver.service.log_structured_event") as mock_log:

            resp = client.post(
                "/v1/resolve",
                headers={"Authorization": f"Bearer {VALID_TOKEN}"},
                json={"schema_version": 1, "url": "https://www.bilibili.com/video/BV1xx411c7mD"},
            )

            self.assertEqual(resp.status_code, 200)
            mock_log.assert_called_once()
            level, payload = mock_log.call_args[0]
            self.assertEqual(level, logging.WARNING)
            self.assertEqual(payload["event"], "resolve_complete")
            self.assertEqual(payload["http_status"], 200)  # Tools response
            self.assertEqual(payload["resolution_status"], "unavailable")
            self.assertEqual(payload["upstream_http_status"], 412)  # Origin response
            self.assertEqual(payload["code"], "ACCESS_BLOCKED")

    def test_rejections_and_exception_logging(self):
        """Verify 401, 422, and 500 exceptions emit structured logs."""
        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}), \
             patch("url_resolver.service.log_structured_event") as mock_log:

            # 1. Test 401 missing auth
            resp = client.post("/v1/resolve", json={"schema_version": 1, "url": "https://example.com"})
            self.assertEqual(resp.status_code, 401)
            level, payload = mock_log.call_args[0]
            self.assertEqual(level, logging.WARNING)
            self.assertEqual(payload["http_status"], 401)
            self.assertEqual(payload["resolution_status"], "unauthorized")

            # 2. Test 422 validation error
            mock_log.reset_mock()
            resp = client.post("/v1/resolve", headers={"Authorization": f"Bearer {VALID_TOKEN}"}, json={})
            self.assertEqual(resp.status_code, 422)
            level, payload = mock_log.call_args[0]
            self.assertEqual(level, logging.WARNING)
            self.assertEqual(payload["http_status"], 422)
            self.assertEqual(payload["resolution_status"], "validation_error")

        # 3. Test 500 auth_not_configured
        with patch.dict(os.environ, {}, clear=True), \
             patch("url_resolver.service.log_structured_event") as mock_log:

            resp = client.post("/v1/resolve", headers={"Authorization": f"Bearer {VALID_TOKEN}"}, json={"schema_version": 1, "url": "https://example.com"})
            self.assertEqual(resp.status_code, 500)
            level, payload = mock_log.call_args[0]
            self.assertEqual(level, logging.ERROR)
            self.assertEqual(payload["http_status"], 500)
            self.assertEqual(payload["resolution_status"], "server_misconfigured")

    def test_special_characters_in_title_preserve_json(self):
        """Verify titles with quotes and newlines serialize into valid single-line JSON."""
        from url_resolver.service import log_structured_event

        captured_records = []
        handler = logging.Handler()
        handler.emit = lambda r: captured_records.append(r.getMessage())

        svc_logger = logging.getLogger("url_resolver.service")
        svc_logger.addHandler(handler)
        try:
            log_structured_event(logging.INFO, {
                "event": "resolve_complete",
                "title": 'Video with "quotes" and \n newlines and \t tabs',
                "creator": "User with 'single' and \"double\"",
            })
            self.assertEqual(len(captured_records), 1)
            raw_line = captured_records[0]
            self.assertNotIn("\n", raw_line)
            parsed = json.loads(raw_line)
            self.assertEqual(parsed["title"], 'Video with "quotes" and \n newlines and \t tabs')
        finally:
            svc_logger.removeHandler(handler)

    def test_uvicorn_live_probe_suppression_and_business_visibility(self):
        """Integration test: start real uvicorn process, hit probes and resolve, verify stdout."""
        import socket
        import urllib.request
        import urllib.error

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]

        env = os.environ.copy()
        env["TOOLS_INTERNAL_TOKEN"] = VALID_TOKEN
        env["PYTHONUNBUFFERED"] = "1"

        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "url_resolver.service:app", "--host", "127.0.0.1", "--port", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )

        base_url = f"http://127.0.0.1:{port}"
        started = False
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"{base_url}/healthz", timeout=1) as resp:
                    if resp.status == 200:
                        started = True
                        break
            except Exception:
                time.sleep(0.1)

        self.assertTrue(started, "Uvicorn server failed to start within 5 seconds")

        try:
            req = urllib.request.Request(f"{base_url}/readyz")
            with urllib.request.urlopen(req, timeout=2) as resp:
                self.assertEqual(resp.status, 200)

            req_data = json.dumps({"schema_version": 1, "url": "https://example.com"}).encode("utf-8")
            req_unauth = urllib.request.Request(
                f"{base_url}/v1/resolve",
                data=req_data,
                headers={"Content-Type": "application/json", "X-Request-ID": "live-test-trace-id"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req_unauth, timeout=2)
            self.assertEqual(ctx.exception.code, 401)
            self.assertEqual(ctx.exception.headers.get("X-Request-ID"), "live-test-trace-id")

        finally:
            proc.terminate()
            stdout_data, _ = proc.communicate(timeout=5)

        self.assertNotIn('"GET /healthz HTTP/1.1" 200', stdout_data)
        self.assertNotIn('"GET /readyz HTTP/1.1" 200', stdout_data)
        self.assertIn('"event": "resolve_rejected"', stdout_data)
        self.assertIn('"request_id": "live-test-trace-id"', stdout_data)
        self.assertIn('"resolution_status": "unauthorized"', stdout_data)


if __name__ == "__main__":
    unittest.main()

