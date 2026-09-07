"""
Generic HTML metadata parser extracting OpenGraph, Twitter Card, JSON-LD, Microdata, and standard tags.
Follows strict deterministic precedence rules without guessing or LLM inference.
"""

import json
import re
from typing import Any, Dict, Optional, Tuple
from bs4 import BeautifulSoup

PLACEHOLDER_TITLES = {
    "",
    "视频号",
    "哔哩哔哩",
    "bilibili",
    "youtube",
    "untitled",
    "untitled document",
    "welcome",
}


def parse_iso_duration(val: Any) -> Optional[int]:
    """Parse ISO 8601 duration (e.g. PT570S, PT00H34M15S, PT9M30S, PT9M31S) into integer seconds."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return int(val)
    s = str(val).strip()
    if s.isdigit():
        return int(s)
    m = re.match(r"^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$", s, re.I)
    if m:
        days = int(m.group(1) or 0)
        hours = int(m.group(2) or 0)
        mins = int(m.group(3) or 0)
        secs = float(m.group(4) or 0)
        return int(days * 86400 + hours * 3600 + mins * 60 + secs)
    return None


class GenericMetadataParser:
    """Extracts structured metadata from HTML text via BeautifulSoup and lxml."""

    @classmethod
    def parse(cls, html_text: str) -> Tuple[Dict[str, Any], Optional[str]]:
        """
        Parses HTML and returns (sparse_metadata_dict, raw_page_title).
        All missing fields are None.
        """
        meta: Dict[str, Any] = {
            "title": None,
            "description": None,
            "creator": None,
            "published_at": None,
            "duration_seconds": None,
            "language": None,
            "thumbnail_url": None,
            "view_count": None,
            "like_count": None,
            "comment_count": None,
        }

        if not html_text:
            return meta, None

        soup = BeautifulSoup(html_text, "lxml")
        raw_page_title = soup.title.string.strip() if soup.title and soup.title.string else None

        # Language extraction
        html_tag = soup.find("html")
        if html_tag and html_tag.get("lang"):
            meta["language"] = str(html_tag["lang"]).strip()

        # Meta tag lookups (OpenGraph, Twitter, Standard, Microdata)
        def find_meta_content(attr_name: str, attr_val: str) -> Optional[str]:
            tag = soup.find(attrs={attr_name: attr_val})
            if tag:
                for content_attr in ("content", "href"):
                    if tag.get(content_attr):
                        val = str(tag[content_attr]).strip()
                        if val:
                            return val
            return None

        og_title = find_meta_content("property", "og:title")
        twitter_title = find_meta_content("name", "twitter:title") or find_meta_content("property", "twitter:title")

        og_desc = find_meta_content("property", "og:description")
        twitter_desc = find_meta_content("name", "twitter:description") or find_meta_content("property", "twitter:description")
        std_desc = find_meta_content("name", "description") or find_meta_content("itemprop", "description")

        og_image = find_meta_content("property", "og:image")
        twitter_image = find_meta_content("name", "twitter:image") or find_meta_content("property", "twitter:image")
        std_image = find_meta_content("itemprop", "image") or find_meta_content("itemprop", "thumbnailUrl")

        og_author = find_meta_content("property", "article:author")
        twitter_creator = find_meta_content("name", "twitter:creator") or find_meta_content("property", "twitter:creator")
        std_author = find_meta_content("name", "author")

        # Standard schema.org microdata for author (<span itemprop="author"><link itemprop="name" content="...">)
        if not std_author:
            author_container = soup.find(attrs={"itemprop": "author"})
            if author_container:
                name_tag = author_container.find(attrs={"itemprop": "name"})
                if name_tag:
                    std_author = name_tag.get("content") or (name_tag.string.strip() if name_tag.string else None)

        og_pub_date = find_meta_content("property", "article:published_time")
        std_pub_date = (
            find_meta_content("itemprop", "datePublished")
            or find_meta_content("itemprop", "uploadDate")
            or find_meta_content("name", "date")
            or find_meta_content("name", "pubdate")
        )

        std_duration = parse_iso_duration(find_meta_content("itemprop", "duration"))
        std_view_count = find_meta_content("itemprop", "interactionCount")

        # JSON-LD Lookups
        json_ld_title = None
        json_ld_desc = None
        json_ld_image = None
        json_ld_author = None
        json_ld_date = None
        json_ld_duration = None
        json_ld_lang = None
        json_ld_view_count = None
        json_ld_like_count = None
        json_ld_comment_count = None

        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            if not script.string:
                continue
            try:
                data = json.loads(script.string.strip())
                items = data if isinstance(data, list) else [data]
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    if not json_ld_title and "name" in item:
                        json_ld_title = str(item["name"]).strip()
                    if not json_ld_desc and "description" in item:
                        json_ld_desc = str(item["description"]).strip()
                    if not json_ld_image and "thumbnailUrl" in item:
                        t = item["thumbnailUrl"]
                        json_ld_image = t[0] if isinstance(t, list) and t else (str(t) if t else None)
                    if not json_ld_author and "author" in item:
                        a = item["author"]
                        if isinstance(a, dict) and "name" in a:
                            json_ld_author = str(a["name"]).strip()
                        elif isinstance(a, str):
                            json_ld_author = a.strip()
                        elif isinstance(a, list) and a and isinstance(a[0], dict) and "name" in a[0]:
                            json_ld_author = str(a[0]["name"]).strip()
                    if not json_ld_date and "uploadDate" in item:
                        json_ld_date = str(item["uploadDate"]).strip()
                    if not json_ld_duration and "duration" in item:
                        json_ld_duration = parse_iso_duration(item["duration"])
                    if not json_ld_lang and "inLanguage" in item:
                        json_ld_lang = str(item["inLanguage"]).strip()
                    if "interactionStatistic" in item:
                        stats = item["interactionStatistic"]
                        stat_list = stats if isinstance(stats, list) else [stats]
                        for s in stat_list:
                            if isinstance(s, dict):
                                itype = str(s.get("interactionType", {}).get("@type", "")).lower()
                                count = s.get("userInteractionCount")
                                if "watchaction" in itype or "view" in itype:
                                    json_ld_view_count = count
                                elif "like" in itype:
                                    json_ld_like_count = count
                                elif "comment" in itype:
                                    json_ld_comment_count = count
            except Exception:
                pass

        # Apply deterministic precedence
        candidate_title = og_title or twitter_title or json_ld_title or raw_page_title
        if candidate_title and candidate_title.strip().lower() in PLACEHOLDER_TITLES:
            candidate_title = None

        meta["title"] = candidate_title
        meta["description"] = og_desc or twitter_desc or json_ld_desc or std_desc
        meta["thumbnail_url"] = og_image or twitter_image or json_ld_image or std_image
        meta["creator"] = og_author or twitter_creator or json_ld_author or std_author

        pub_candidate = og_pub_date or json_ld_date or std_pub_date
        if pub_candidate:
            m_date = re.match(r"^(\d{4}-\d{2}-\d{2})", pub_candidate)
            meta["published_at"] = m_date.group(1) if m_date else pub_candidate

        meta["duration_seconds"] = json_ld_duration or std_duration
        if json_ld_lang and not meta["language"]:
            meta["language"] = json_ld_lang

        meta["view_count"] = json_ld_view_count or std_view_count
        meta["like_count"] = json_ld_like_count
        meta["comment_count"] = json_ld_comment_count

        return meta, raw_page_title
