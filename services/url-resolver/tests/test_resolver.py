"""
End-to-end integration tests for resolve_url entrypoint.
"""

import unittest
from unittest.mock import patch, MagicMock
from url_resolver import resolve_url, ResolverValidationError, ResolutionOutcome


class TestResolveUrlEntrypoint(unittest.TestCase):
    def test_resolve_generic_web(self):
        html = """
        <html>
        <head>
            <meta property="og:title" content="Tech News Today" />
            <meta property="og:description" content="Daily tech summary" />
        </head>
        <body>Valid article content body here</body>
        </html>
        """
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.url = "https://example.com/article"
        mock_resp.html_content = html
        mock_resp.headers = {"content-type": "text/html"}

        with patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            outcome = resolve_url("https://example.com/article")
            self.assertEqual(outcome.status, "resolved")
            self.assertEqual(outcome.metadata.title, "Tech News Today")
            self.assertEqual(outcome.metadata.description, "Daily tech summary")
            self.assertEqual(outcome.metadata.source_type, "web")
            self.assertIn("title", outcome.fields_resolved)
            self.assertIn("description", outcome.fields_resolved)

    def test_resolve_youtube_oembed(self):
        from url_resolver.fetch.base import FetchResult

        oembed_json = '{"title": "Oembed Title", "author_name": "Oembed Creator", "thumbnail_url": "https://img.com/t.jpg"}'
        mock_oembed_res = FetchResult(
            requested_url="https://www.youtube.com/oembed",
            final_url="https://www.youtube.com/oembed",
            http_status=200,
            content_type="application/json",
            headers={},
            body=oembed_json,
            latency_ms=80,
        )

        with patch("url_resolver.fetch.direct_http.DirectHttpFetcher.fetch", return_value=mock_oembed_res):
            outcome = resolve_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            self.assertEqual(outcome.status, "resolved")
            self.assertEqual(outcome.metadata.source_type, "youtube")
            self.assertEqual(outcome.metadata.source_id, "dQw4w9WgXcQ")
            self.assertEqual(outcome.metadata.title, "Oembed Title")
            self.assertEqual(outcome.metadata.creator, "Oembed Creator")
            self.assertEqual(outcome.diagnostics.strategy, "youtube_oembed")

    def test_resolve_youtube_fallback_generic(self):
        from url_resolver.fetch.base import FetchResult

        mock_oembed_err = FetchResult(
            requested_url="https://www.youtube.com/oembed",
            final_url="https://www.youtube.com/oembed",
            http_status=404,
            content_type="text/plain",
            headers={},
            body="Not Found",
            latency_ms=50,
        )

        html = """
        <html>
        <head>
            <meta property="og:title" content="Rick Astley Video" />
            <meta property="og:image" content="https://img.youtube.com/thumb.jpg" />
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "VideoObject",
                "name": "Rick Astley Video",
                "duration": "PT213S",
                "author": {"name": "RickAstleyVEVO"}
            }
            </script>
        </head>
        <body>YouTube player webpage content here</body>
        </html>
        """
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        mock_resp.html_content = html
        mock_resp.headers = {}

        with patch("url_resolver.fetch.direct_http.DirectHttpFetcher.fetch", return_value=mock_oembed_err), \
             patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            outcome = resolve_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            self.assertEqual(outcome.status, "resolved")
            self.assertEqual(outcome.metadata.source_type, "youtube")
            self.assertEqual(outcome.metadata.source_id, "dQw4w9WgXcQ")
            self.assertEqual(outcome.metadata.title, "Rick Astley Video")
            self.assertEqual(outcome.metadata.creator, "RickAstleyVEVO")
            self.assertEqual(outcome.metadata.duration_seconds, 213)
            self.assertEqual(outcome.diagnostics.strategy, "generic_static")

    def test_resolve_malformed_url_raises_exception(self):
        with self.assertRaises(ResolverValidationError):
            resolve_url("htp:/not-a-url")


if __name__ == "__main__":
    unittest.main()

