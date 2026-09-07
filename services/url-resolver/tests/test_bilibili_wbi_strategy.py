"""
Unit tests for BilibiliWbiStrategy and its integration with ResolverRouter.
"""

import json
import unittest
from unittest.mock import MagicMock
from url_resolver.fetch.base import FetchRequest, FetchResult, WebFetcher
from url_resolver.models import ContentMetadataV1, Diagnostics, ResolutionOutcome
from url_resolver.router import ResolverRouter
from url_resolver.strategies.base import BaseStrategy
from url_resolver.strategies.bilibili_wbi import BilibiliWbiStrategy
from url_resolver.strategies.generic_static import GenericStaticStrategy
from url_resolver.strategies.weixin_preview import WeixinPreviewStrategy


class TestBilibiliWbiStrategy(unittest.TestCase):
    def setUp(self):
        self.mock_fetcher = MagicMock(spec=WebFetcher)
        self.mock_fallback = MagicMock(spec=BaseStrategy)
        self.strategy = BilibiliWbiStrategy(
            api_fetcher=self.mock_fetcher,
            fallback_strategy=self.mock_fallback,
        )

    def test_bilibili_wbi_success(self):
        """Verify successful WBI API response is mapped to ContentMetadataV1."""
        api_payload = {
            "code": 0,
            "message": "OK",
            "data": {
                "bvid": "BV1xx411c7mD",
                "aid": 2,
                "title": "字幕君交流场所",
                "desc": "交流场所简介",
                "owner": {"name": "碧诗", "mid": 2},
                "pubdate": 1700000000,
                "duration": 2055,
                "pic": "https://i0.hdslb.com/bfs/archive/pic.png",
                "stat": {"view": 5400000, "like": 270000, "reply": 89000},
            },
        }
        self.mock_fetcher.fetch.return_value = FetchResult(
            requested_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            final_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            http_status=200,
            content_type="application/json",
            headers={"content-type": "application/json"},
            body=json.dumps(api_payload),
            latency_ms=80,
            blocked=False,
        )

        outcome = self.strategy.resolve(
            url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_type="bilibili",
            source_id="BV1xx411c7mD",
        )

        self.assertEqual(outcome.status, "resolved")
        self.assertEqual(outcome.diagnostics.strategy, "bilibili_wbi")
        self.assertEqual(outcome.diagnostics.fetch_status, "ok")
        self.assertEqual(outcome.diagnostics.http_status, 200)

        meta = outcome.metadata
        self.assertEqual(meta.title, "字幕君交流场所")
        self.assertEqual(meta.description, "交流场所简介")
        self.assertEqual(meta.creator, "碧诗")
        self.assertEqual(meta.published_at, "2023-11-14")
        self.assertEqual(meta.duration_seconds, 2055)
        self.assertEqual(meta.thumbnail_url, "https://i0.hdslb.com/bfs/archive/pic.png")
        self.assertEqual(meta.view_count, 5400000)
        self.assertEqual(meta.like_count, 270000)
        self.assertEqual(meta.comment_count, 89000)

        self.assertIn("title", outcome.fields_resolved)
        self.assertIn("creator", outcome.fields_resolved)
        self.assertIn("published_at", outcome.fields_resolved)
        self.assertIn("duration_seconds", outcome.fields_resolved)
        self.mock_fallback.resolve.assert_not_called()

    def test_bilibili_wbi_nonzero_code_falls_back(self):
        """Verify API returning non-zero code (e.g. -412 banned) falls back to GenericStaticStrategy."""
        self.mock_fetcher.fetch.return_value = FetchResult(
            requested_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            final_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            http_status=200,
            content_type="application/json",
            headers={"content-type": "application/json"},
            body=json.dumps({"code": -412, "message": "request was banned"}),
            latency_ms=90,
            blocked=False,
        )

        dummy_fallback = ResolutionOutcome(
            status="unavailable",
            metadata=ContentMetadataV1(schema_version=1, source_type="bilibili", source_url="https://www.bilibili.com/video/BV1xx411c7mD"),
            fields_resolved=[],
            diagnostics=Diagnostics(strategy="generic_static", fetch_status="blocked", http_status=412, code="ACCESS_BLOCKED"),
        )
        self.mock_fallback.resolve.return_value = dummy_fallback

        outcome = self.strategy.resolve(
            url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_type="bilibili",
            source_id="BV1xx411c7mD",
        )

        self.mock_fallback.resolve.assert_called_once_with(
            "https://www.bilibili.com/video/BV1xx411c7mD", "bilibili", "BV1xx411c7mD", None
        )
        self.assertEqual(outcome, dummy_fallback)

    def test_bilibili_wbi_invalid_json_falls_back(self):
        """Verify API returning invalid JSON HTML body falls back to GenericStaticStrategy."""
        self.mock_fetcher.fetch.return_value = FetchResult(
            requested_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            final_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            http_status=200,
            content_type="text/html",
            headers={"content-type": "text/html"},
            body="<html><head><title>出错啦!</title></head></html>",
            latency_ms=50,
            blocked=False,
        )

        self.strategy.resolve(
            url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_type="bilibili",
            source_id="BV1xx411c7mD",
        )
        self.mock_fallback.resolve.assert_called_once()

    def test_bilibili_wbi_transport_failure_falls_back(self):
        """Verify transport network failure (http_status=0, blocked=True) falls back."""
        self.mock_fetcher.fetch.return_value = FetchResult(
            requested_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            final_url="https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD",
            http_status=0,
            content_type=None,
            headers={},
            body="",
            latency_ms=10,
            blocked=True,
            block_reason="NETWORK_ERROR: Connection refused",
        )

        self.strategy.resolve(
            url="https://www.bilibili.com/video/BV1xx411c7mD",
            source_type="bilibili",
            source_id="BV1xx411c7mD",
        )
        self.mock_fallback.resolve.assert_called_once()

    def test_bilibili_wbi_missing_source_id_falls_back(self):
        """Verify URLs without source_id (e.g. b23.tv redirect stub) fall back immediately without API call."""
        self.strategy.resolve(
            url="https://b23.tv/shortlink",
            source_type="bilibili",
            source_id=None,
        )
        self.mock_fetcher.fetch.assert_not_called()
        self.mock_fallback.resolve.assert_called_once_with(
            "https://b23.tv/shortlink", "bilibili", None, None
        )

    def test_router_routes_bilibili_to_wbi_strategy(self):
        """Verify ResolverRouter routes bilibili URLs to BilibiliWbiStrategy."""
        router = ResolverRouter()
        bili_strategy = router.route("https://www.bilibili.com/video/BV1xx411c7mD")
        self.assertIsInstance(bili_strategy, BilibiliWbiStrategy)

        weixin_strategy = router.route("https://weixin.qq.com/sph/AF17JEGHVd")
        self.assertIsInstance(weixin_strategy, WeixinPreviewStrategy)

        from url_resolver.strategies.youtube_oembed import YoutubeOembedStrategy
        yt_strategy = router.route("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertIsInstance(yt_strategy, YoutubeOembedStrategy)


if __name__ == "__main__":
    unittest.main()

