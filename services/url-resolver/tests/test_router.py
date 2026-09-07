"""
Unit tests for ResolverRouter.
Verifies validation, identification, identifier extraction, and strategy selection.
"""

import unittest
from url_resolver.models import InvalidUrlError, ResolverValidationError, UnsupportedProtocolError
from url_resolver.router import ResolverRouter
from url_resolver.strategies.generic_static import GenericStaticStrategy
from url_resolver.strategies.weixin_preview import WeixinPreviewStrategy


class TestResolverRouter(unittest.TestCase):
    def setUp(self):
        self.router = ResolverRouter()

    def test_validate_empty_url(self):
        with self.assertRaises(InvalidUrlError):
            self.router.validate_and_normalize("")
        with self.assertRaises(InvalidUrlError):
            self.router.validate_and_normalize("   ")

    def test_validate_unsupported_scheme(self):
        with self.assertRaises(UnsupportedProtocolError):
            self.router.validate_and_normalize("ftp://example.com/file")
        with self.assertRaises(UnsupportedProtocolError):
            self.router.validate_and_normalize("file:///path/to/file")

    def test_validate_missing_scheme(self):
        with self.assertRaises(InvalidUrlError):
            self.router.validate_and_normalize("www.youtube.com/watch?v=123")

    def test_identify_youtube(self):
        url = "https://www.youtube.com/watch?v=jMjSVF14j30&feature=share"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "youtube")
        self.assertEqual(sid, "jMjSVF14j30")
        self.assertEqual(canon, "https://www.youtube.com/watch?v=jMjSVF14j30")

    def test_identify_youtube_short(self):
        url = "https://youtu.be/jMjSVF14j30?si=abc"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "youtube")
        self.assertEqual(sid, "jMjSVF14j30")
        self.assertEqual(canon, "https://www.youtube.com/watch?v=jMjSVF14j30")

    def test_identify_youtube_shorts(self):
        url = "https://www.youtube.com/shorts/jMjSVF14j30?feature=share"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "youtube")
        self.assertEqual(sid, "jMjSVF14j30")
        self.assertEqual(canon, "https://www.youtube.com/watch?v=jMjSVF14j30")

    def test_identify_youtube_live(self):
        url = "https://www.youtube.com/live/jMjSVF14j30"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "youtube")
        self.assertEqual(sid, "jMjSVF14j30")
        self.assertEqual(canon, "https://www.youtube.com/watch?v=jMjSVF14j30")

    def test_identify_youtube_embed(self):
        url = "https://www.youtube.com/embed/jMjSVF14j30"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "youtube")
        self.assertEqual(sid, "jMjSVF14j30")
        self.assertEqual(canon, "https://www.youtube.com/watch?v=jMjSVF14j30")

    def test_identify_spoofed_youtube_hostnames(self):
        # Domains containing youtube.com as substring or in path/query must not be matched as youtube
        spoofs = [
            "https://notyoutube.com/watch?v=123",
            "https://youtube.com.attacker.org/watch?v=123",
            "https://example.com/watch?v=123&domain=youtube.com",
        ]
        for sp in spoofs:
            st, sid, canon = self.router.identify(sp)
            self.assertEqual(st, "web", f"Failed spoof protection for {sp}")

    def test_identify_bilibili(self):
        url = "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "bilibili")
        self.assertEqual(sid, "BV1xx411c7mD")
        self.assertEqual(canon, "https://www.bilibili.com/video/BV1xx411c7mD")

    def test_identify_weixin(self):
        url = "https://weixin.qq.com/sph/AF17JEGHVd"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "weixin")
        self.assertEqual(sid, "AF17JEGHVd")
        self.assertEqual(canon, "https://weixin.qq.com/sph/AF17JEGHVd")

    def test_identify_generic_web(self):
        url = "https://news.ycombinator.com/item?id=12345"
        st, sid, canon = self.router.identify(url)
        self.assertEqual(st, "web")
        self.assertIsNone(sid)
        self.assertEqual(canon, url)

    def test_route_platforms(self):
        from url_resolver.strategies.bilibili_wbi import BilibiliWbiStrategy
        from url_resolver.strategies.youtube_oembed import YoutubeOembedStrategy

        wx_strat = self.router.route("https://weixin.qq.com/sph/AF123")
        self.assertIsInstance(wx_strat, WeixinPreviewStrategy)

        yt_strat = self.router.route("https://www.youtube.com/watch?v=123")
        self.assertIsInstance(yt_strat, YoutubeOembedStrategy)

        bili_strat = self.router.route("https://www.bilibili.com/video/BV123")
        self.assertIsInstance(bili_strat, BilibiliWbiStrategy)

        web_strat = self.router.route("https://example.com")
        self.assertIsInstance(web_strat, GenericStaticStrategy)


if __name__ == "__main__":
    unittest.main()
