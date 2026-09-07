"""
Unit tests for WebFetcher implementations (ScraplingStaticFetcher & DirectHttpFetcher).
"""

import unittest
from unittest.mock import MagicMock, patch
from url_resolver.fetch.base import FetchRequest, FetchResult
from url_resolver.fetch.direct_http import DirectHttpFetcher
from url_resolver.fetch.scrapling_static import ScraplingStaticFetcher


class TestFetchers(unittest.TestCase):
    def test_scrapling_static_success(self):
        fetcher = ScraplingStaticFetcher()
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.url = "https://example.com/final"
        mock_resp.html_content = "<html><head><title>Test</title></head><body>Content here</body></html>"
        mock_resp.headers = {"content-type": "text/html"}

        with patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            res = fetcher.fetch_url("https://example.com")
            self.assertEqual(res.http_status, 200)
            self.assertEqual(res.final_url, "https://example.com/final")
            self.assertIn("Content here", res.body)
            self.assertFalse(res.blocked)
            self.assertIsNone(res.block_reason)

    def test_scrapling_static_block_detection_412(self):
        fetcher = ScraplingStaticFetcher()
        mock_resp = MagicMock()
        mock_resp.status = 412
        mock_resp.url = "https://example.com"
        mock_resp.html_content = "<html>Precondition Failed</html>"
        mock_resp.headers = {}

        with patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            res = fetcher.fetch_url("https://example.com")
            self.assertEqual(res.http_status, 412)
            self.assertTrue(res.blocked)
            self.assertIn("412", res.block_reason)

    def test_scrapling_static_block_detection_bot_challenge(self):
        fetcher = ScraplingStaticFetcher()
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.url = "https://youtube.com/watch?v=123"
        mock_resp.html_content = "<html>Sign in to confirm you’re not a bot</html>"
        mock_resp.headers = {}

        with patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            res = fetcher.fetch_url("https://youtube.com")
            self.assertTrue(res.blocked)
            self.assertIn("Bot Challenge", res.block_reason)

    def test_scrapling_static_timeout_exception(self):
        fetcher = ScraplingStaticFetcher()
        with patch("scrapling.fetchers.Fetcher.get", side_effect=TimeoutError("Connection timed out")):
            res = fetcher.fetch_url("https://example.com")
            self.assertTrue(res.blocked)
            self.assertIn("TIMEOUT", res.block_reason)

    def test_direct_http_fetcher_post(self):
        fetcher = DirectHttpFetcher()
        mock_client = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.url = "https://api.example.com/endpoint"
        mock_resp.text = '{"errCode": 0, "msg": "ok"}'
        mock_resp.headers = {"content-type": "application/json"}
        mock_client.__enter__.return_value.post.return_value = mock_resp

        with patch("httpx.Client", return_value=mock_client):
            req = FetchRequest(url="https://api.example.com/endpoint", method="POST", json_body={"id": 1})
            res = fetcher.fetch(req)
            self.assertEqual(res.http_status, 200)
            self.assertIn('"errCode": 0', res.body)
            self.assertFalse(res.blocked)


if __name__ == "__main__":
    unittest.main()
