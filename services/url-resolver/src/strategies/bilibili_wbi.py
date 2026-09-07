"""
Bilibili WBI API strategy with graceful fallback to GenericStaticStrategy.
"""

import datetime
import json
from typing import Optional
from ..fetch import DirectHttpFetcher, FetchRequest, FetchResult, WebFetcher
from ..models import ContentMetadataV1, ResolutionOutcome
from .base import BaseStrategy
from .generic_static import GenericStaticStrategy


class BilibiliWbiStrategy(BaseStrategy):
    """
    Optimized strategy for Bilibili video URLs.
    Calls the public anonymous endpoint https://api.bilibili.com/x/web-interface/wbi/view?bvid=...
    On non-zero code, transport error, or missing BV ID, gracefully falls back to GenericStaticStrategy.
    """

    API_URL = "https://api.bilibili.com/x/web-interface/wbi/view"

    def __init__(
        self,
        api_fetcher: Optional[WebFetcher] = None,
        fallback_strategy: Optional[BaseStrategy] = None,
    ):
        self.api_fetcher = api_fetcher or DirectHttpFetcher()
        self.fallback_strategy = fallback_strategy or GenericStaticStrategy()

    def resolve(
        self,
        url: str,
        source_type: str,
        source_id: Optional[str] = None,
        canonical_url: Optional[str] = None,
    ) -> ResolutionOutcome:
        bvid = source_id or ""

        # If no BV ID could be extracted from the URL (e.g. shortlinks b23.tv without BV in path),
        # immediately fall back to GenericStaticStrategy to follow redirects
        if not bvid:
            return self.fallback_strategy.resolve(url, source_type, source_id, canonical_url)

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.bilibili.com/",
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }

        req = FetchRequest(
            url=f"{self.API_URL}?bvid={bvid}",
            method="GET",
            headers=headers,
            timeout_seconds=10.0,
        )

        res: FetchResult = self.api_fetcher.fetch(req)

        if res.http_status == 200 and res.body:
            try:
                data_json = json.loads(res.body)
                if isinstance(data_json, dict) and data_json.get("code") == 0:
                    data = data_json.get("data")
                    if isinstance(data, dict):
                        title = data.get("title") or None
                        desc = data.get("desc") or None

                        owner = data.get("owner") or {}
                        creator = owner.get("name") if isinstance(owner, dict) else None

                        published_at = None
                        pubdate = data.get("pubdate")
                        if pubdate and isinstance(pubdate, (int, float)):
                            try:
                                dt = datetime.datetime.fromtimestamp(pubdate, datetime.timezone.utc)
                                published_at = dt.strftime("%Y-%m-%d")
                            except Exception:
                                pass

                        duration_seconds = data.get("duration")
                        if not isinstance(duration_seconds, (int, float)):
                            duration_seconds = None

                        thumbnail_url = data.get("pic") or None

                        stat = data.get("stat") or {}
                        view_cnt = stat.get("view") if isinstance(stat, dict) else None
                        like_cnt = stat.get("like") if isinstance(stat, dict) else None
                        reply_cnt = stat.get("reply") if isinstance(stat, dict) else None

                        meta = ContentMetadataV1(
                            schema_version=1,
                            source_type="bilibili",
                            source_url=url,
                            canonical_url=canonical_url or f"https://www.bilibili.com/video/{bvid}",
                            source_id=bvid,
                            title=title,
                            description=desc,
                            creator=creator,
                            published_at=published_at,
                            duration_seconds=duration_seconds,
                            thumbnail_url=thumbnail_url,
                            view_count=view_cnt,
                            like_count=like_cnt,
                            comment_count=reply_cnt,
                        )

                        return self.build_outcome(
                            metadata=meta,
                            strategy_name="bilibili_wbi",
                            fetch_status="ok",
                            http_status=res.http_status,
                            code=None,
                        )
            except Exception:
                pass

        # Any API failure, non-zero code, or invalid JSON falls back to GenericStaticStrategy
        return self.fallback_strategy.resolve(url, source_type, source_id, canonical_url)
