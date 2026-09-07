"""
Unit tests for FastAPI HTTP service in url_resolver.service.
Tests /healthz, /readyz, authentication, and /v1/resolve endpoints.
"""

import os
import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from url_resolver.models import ContentMetadataV1, Diagnostics, ResolutionOutcome
from url_resolver.service import app

client = TestClient(app)
VALID_TOKEN = "test-token-abcdef-123456"


class TestService(unittest.TestCase):
    def test_healthz(self):
        resp = client.get("/healthz")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "ok"})

    def test_readyz_fails_closed_when_token_unset(self):
        with patch.dict(os.environ, {}, clear=True):
            resp = client.get("/readyz")
            self.assertEqual(resp.status_code, 503)
            self.assertEqual(resp.json()["status"], "not_ready")

    def test_readyz_succeeds_when_token_set(self):
        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}):
            resp = client.get("/readyz")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "ready")

    def test_resolve_unauthorized_when_header_missing(self):
        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}):
            resp = client.post("/v1/resolve", json={"schema_version": 1, "url": "https://example.com"})
            self.assertEqual(resp.status_code, 401)
            self.assertEqual(resp.json()["detail"]["code"], "unauthorized")

    def test_resolve_unauthorized_when_token_invalid(self):
        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}):
            resp = client.post(
                "/v1/resolve",
                headers={"Authorization": "Bearer wrong-token"},
                json={"schema_version": 1, "url": "https://example.com"},
            )
            self.assertEqual(resp.status_code, 401)

    def test_resolve_server_auth_unconfigured(self):
        with patch.dict(os.environ, {}, clear=True):
            resp = client.post(
                "/v1/resolve",
                headers={"Authorization": f"Bearer {VALID_TOKEN}"},
                json={"schema_version": 1, "url": "https://example.com"},
            )
            self.assertEqual(resp.status_code, 500)
            self.assertEqual(resp.json()["detail"]["code"], "auth_not_configured")

    def test_resolve_invalid_url_returns_400(self):
        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}):
            resp = client.post(
                "/v1/resolve",
                headers={"Authorization": f"Bearer {VALID_TOKEN}"},
                json={"schema_version": 1, "url": "not-a-valid-url"},
            )
            self.assertEqual(resp.status_code, 400)
            self.assertEqual(resp.json()["detail"]["code"], "invalid_url")

    def test_resolve_success_returns_outcome(self):
        mock_outcome = ResolutionOutcome(
            status="resolved",
            fields_resolved=["title", "creator"],
            metadata=ContentMetadataV1(
                schema_version=1,
                source_type="youtube",
                source_url="https://www.youtube.com/watch?v=123",
                canonical_url="https://www.youtube.com/watch?v=123",
                source_id="123",
                title="Mock Video Title",
                creator="Mock Creator",
            ),
            diagnostics=Diagnostics(
                strategy="generic_static",
                fetch_status="ok",
                http_status=200,
            ),
        )

        with patch.dict(os.environ, {"TOOLS_INTERNAL_TOKEN": VALID_TOKEN}):
            with patch("url_resolver.service.resolve_url", return_value=mock_outcome):
                resp = client.post(
                    "/v1/resolve",
                    headers={"Authorization": f"Bearer {VALID_TOKEN}"},
                    json={"schema_version": 1, "url": "https://www.youtube.com/watch?v=123"},
                )
                self.assertEqual(resp.status_code, 200)
                data = resp.json()
                self.assertEqual(data["status"], "resolved")
                self.assertEqual(data["fields_resolved"], ["title", "creator"])
                self.assertEqual(data["metadata"]["title"], "Mock Video Title")
                self.assertEqual(data["diagnostics"]["strategy"], "generic_static")


if __name__ == "__main__":
    unittest.main()
