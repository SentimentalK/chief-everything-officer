"""
Pure string parser for Bilibili embedded window.__INITIAL_STATE__.
Extracts structured metadata from HTML already fetched.
Strictly zero network I/O.
"""

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict


def parse_bilibili_initial_state(html_text: str) -> Dict[str, Any]:
    """
    Extracts structured fields from window.__INITIAL_STATE__ if present in HTML.
    Returns a dict of enriched fields (title, creator, duration_seconds, etc.).
    """
    result: Dict[str, Any] = {}
    if not html_text or "__INITIAL_STATE__" not in html_text:
        return result

    # Match window.__INITIAL_STATE__ = {...}; or window.__INITIAL_STATE__={...};
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*(?:try|window|\(function|</script>)", html_text, re.DOTALL)
    if not m:
        # Fallback greedy match up to </script>
        m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});", html_text, re.DOTALL)

    if not m:
        return result

    raw_json = m.group(1)
    try:
        data = json.loads(raw_json)
    except Exception:
        return result

    video_data = data.get("videoData")
    if not isinstance(video_data, dict):
        return result

    if "title" in video_data and video_data["title"]:
        result["title"] = str(video_data["title"]).strip()

    owner = video_data.get("owner")
    if isinstance(owner, dict) and "name" in owner and owner["name"]:
        result["creator"] = str(owner["name"]).strip()

    if "duration" in video_data and isinstance(video_data["duration"], (int, float)):
        result["duration_seconds"] = int(video_data["duration"])

    if "pic" in video_data and video_data["pic"]:
        pic = str(video_data["pic"]).strip()
        if pic.startswith("//"):
            pic = f"https:{pic}"
        result["thumbnail_url"] = pic

    if "desc" in video_data and video_data["desc"]:
        result["description"] = str(video_data["desc"]).strip()

    if "bvid" in video_data and video_data["bvid"]:
        result["source_id"] = str(video_data["bvid"]).strip()

    if "pubdate" in video_data and isinstance(video_data["pubdate"], (int, float)):
        try:
            pub_dt = datetime.fromtimestamp(video_data["pubdate"], timezone.utc)
            result["published_at"] = pub_dt.strftime("%Y-%m-%d")
        except Exception:
            pass

    stat = video_data.get("stat")
    if isinstance(stat, dict):
        if "view" in stat:
            result["view_count"] = stat["view"]
        if "like" in stat:
            result["like_count"] = stat["like"]
        if "reply" in stat:
            result["comment_count"] = stat["reply"]

    return result
