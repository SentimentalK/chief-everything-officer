"""
Unit tests for Bilibili embedded __INITIAL_STATE__ parser.
Verifies pure string extraction without network calls.
"""

import unittest
from url_resolver.parser.embedded.bilibili import parse_bilibili_initial_state


class TestBilibiliEmbeddedParser(unittest.TestCase):
    def test_parse_valid_initial_state(self):
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <script>
            window.__INITIAL_STATE__={"bvid":"BV1xx411c7mD","videoData":{"bvid":"BV1xx411c7mD","title":"字幕君交流场所","pic":"//i0.hdslb.com/bfs/archive/pic.jpg","desc":"Video description here","duration":2055,"pubdate":1252458549,"owner":{"name":"碧诗","mid":2},"stat":{"view":5493402,"like":276129,"reply":128393}}};(function(){var s;})();
            </script>
        </head>
        </html>
        """
        data = parse_bilibili_initial_state(html)
        self.assertEqual(data["title"], "字幕君交流场所")
        self.assertEqual(data["creator"], "碧诗")
        self.assertEqual(data["duration_seconds"], 2055)
        self.assertEqual(data["thumbnail_url"], "https://i0.hdslb.com/bfs/archive/pic.jpg")
        self.assertEqual(data["description"], "Video description here")
        self.assertEqual(data["source_id"], "BV1xx411c7mD")
        self.assertEqual(data["published_at"], "2009-09-09")
        self.assertEqual(data["view_count"], 5493402)
        self.assertEqual(data["like_count"], 276129)
        self.assertEqual(data["comment_count"], 128393)

    def test_parse_missing_state_returns_empty(self):
        html = "<html><head><title>No State</title></head></html>"
        data = parse_bilibili_initial_state(html)
        self.assertEqual(data, {})

    def test_parse_malformed_json_returns_empty(self):
        html = "<script>window.__INITIAL_STATE__={not-valid-json};</script>"
        data = parse_bilibili_initial_state(html)
        self.assertEqual(data, {})


if __name__ == "__main__":
    unittest.main()
