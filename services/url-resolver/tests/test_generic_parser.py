"""
Unit tests for GenericMetadataParser.
Tests OpenGraph, Twitter Card, JSON-LD, duration normalization, and placeholder filtering.
"""

import unittest
from url_resolver.parser.generic import GenericMetadataParser, parse_iso_duration


class TestGenericMetadataParser(unittest.TestCase):
    def test_parse_iso_duration(self):
        self.assertEqual(parse_iso_duration("PT570S"), 570)
        self.assertEqual(parse_iso_duration("PT9M30S"), 570)
        self.assertEqual(parse_iso_duration("PT00H34M15S"), 2055)
        self.assertEqual(parse_iso_duration("PT1H2M3S"), 3723)
        self.assertEqual(parse_iso_duration("P1DT2H"), 86400 + 7200)
        self.assertEqual(parse_iso_duration(300), 300)
        self.assertEqual(parse_iso_duration("450"), 450)
        self.assertIsNone(parse_iso_duration("invalid"))
        self.assertIsNone(parse_iso_duration(None))

    def test_opengraph_extraction(self):
        html = """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <title>Raw Title</title>
            <meta property="og:title" content="OG Test Video Title" />
            <meta property="og:description" content="This is an OG description." />
            <meta property="og:image" content="https://example.com/thumb.jpg" />
            <meta property="article:author" content="Test Creator" />
            <meta property="article:published_time" content="2026-08-10T12:00:00Z" />
        </head>
        <body></body>
        </html>
        """
        meta, raw_title = GenericMetadataParser.parse(html)
        self.assertEqual(raw_title, "Raw Title")
        self.assertEqual(meta["title"], "OG Test Video Title")
        self.assertEqual(meta["description"], "This is an OG description.")
        self.assertEqual(meta["thumbnail_url"], "https://example.com/thumb.jpg")
        self.assertEqual(meta["creator"], "Test Creator")
        self.assertEqual(meta["published_at"], "2026-08-10")
        self.assertEqual(meta["language"], "zh-CN")

    def test_twitter_card_fallback(self):
        html = """
        <html>
        <head>
            <title>Raw Title</title>
            <meta name="twitter:title" content="Twitter Title" />
            <meta name="twitter:description" content="Twitter Description" />
            <meta name="twitter:image" content="https://example.com/tw_thumb.jpg" />
            <meta name="twitter:creator" content="@tw_creator" />
        </head>
        </html>
        """
        meta, _ = GenericMetadataParser.parse(html)
        self.assertEqual(meta["title"], "Twitter Title")
        self.assertEqual(meta["description"], "Twitter Description")
        self.assertEqual(meta["thumbnail_url"], "https://example.com/tw_thumb.jpg")
        self.assertEqual(meta["creator"], "@tw_creator")

    def test_jsonld_video_object(self):
        html = """
        <html>
        <head>
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "VideoObject",
                "name": "JSON-LD Title",
                "description": "JSON-LD Desc",
                "thumbnailUrl": ["https://example.com/jsonld_thumb.jpg"],
                "uploadDate": "2026-05-20T08:00:00+00:00",
                "duration": "PT570S",
                "author": {
                    "@type": "Person",
                    "name": "JSON-LD Author"
                },
                "interactionStatistic": [
                    {
                        "@type": "InteractionCounter",
                        "interactionType": {"@type": "http://schema.org/WatchAction"},
                        "userInteractionCount": 12345
                    },
                    {
                        "@type": "InteractionCounter",
                        "interactionType": {"@type": "http://schema.org/LikeAction"},
                        "userInteractionCount": 999
                    }
                ]
            }
            </script>
        </head>
        </html>
        """
        meta, _ = GenericMetadataParser.parse(html)
        self.assertEqual(meta["title"], "JSON-LD Title")
        self.assertEqual(meta["description"], "JSON-LD Desc")
        self.assertEqual(meta["thumbnail_url"], "https://example.com/jsonld_thumb.jpg")
        self.assertEqual(meta["creator"], "JSON-LD Author")
        self.assertEqual(meta["published_at"], "2026-05-20")
        self.assertEqual(meta["duration_seconds"], 570)
        self.assertEqual(meta["view_count"], 12345)
        self.assertEqual(meta["like_count"], 999)

    def test_placeholder_title_filtering(self):
        for placeholder in ("视频号", "哔哩哔哩", "bilibili", "YouTube", "untitled", ""):
            html = f"<html><head><title>{placeholder}</title></head><body></body></html>"
            meta, raw_title = GenericMetadataParser.parse(html)
            self.assertIsNone(meta["title"], f"Expected {placeholder} to normalize to None")

    def test_missing_fields_are_none(self):
        html = "<html><head><title>Minimal Title</title></head><body>Empty</body></html>"
        meta, _ = GenericMetadataParser.parse(html)
        self.assertEqual(meta["title"], "Minimal Title")
        self.assertIsNone(meta["description"])
        self.assertIsNone(meta["creator"])
        self.assertIsNone(meta["thumbnail_url"])
        self.assertIsNone(meta["published_at"])
        self.assertIsNone(meta["duration_seconds"])
        self.assertIsNone(meta["view_count"])


if __name__ == "__main__":
    unittest.main()
