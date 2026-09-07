"""
Weixin Channels Preview API strategy with graceful fallback to GenericStaticStrategy.
"""

import datetime
import json
from typing import Optional
from ..fetch import DirectHttpFetcher, FetchRequest, FetchResult, WebFetcher
from ..models import ContentMetadataV1, ResolutionOutcome
from .base import BaseStrategy
from .generic_static import GenericStaticStrategy


class WeixinPreviewStrategy(BaseStrategy):
    """
    Optimized strategy for WeChat Channels (微信视频号).
    Calls Tencent's public anonymous preview JSON endpoint.
    On failure or rate limit, gracefully falls back to GenericStaticStrategy.
    """

    API_URL = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"

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
        sph_id = source_id or ""

        if not sph_id:
            # Cannot call preview API without short ID, fallback directly
            return self.fallback_strategy.resolve(url, source_type, source_id, canonical_url)

        headers = {
            "Content-Type": "application/json",
            "Referer": f"https://channels.weixin.qq.com/finder-preview/pages/sph?id={sph_id}",
            "Origin": "https://channels.weixin.qq.com",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        }

        payload = {
            "baseReq": {"generalToken": ""},
            "shortUri": sph_id,
        }

        req = FetchRequest(
            url=self.API_URL,
            method="POST",
            headers=headers,
            json_body=payload,
            timeout_seconds=10.0,
        )

        res: FetchResult = self.api_fetcher.fetch(req)

        if res.http_status in (200, 201) and res.body:
            try:
                data = json.loads(res.body)
                if isinstance(data, dict) and data.get("errCode") == 0:
                    data_block = data.get("data") or {}
                    author_info = data_block.get("authorInfo") or {}
                    feed_info = data_block.get("feedInfo") or {}
                    scene_info = data_block.get("sceneInfo") or {}

                    author_name = author_info.get("nickname") or None
                    title = feed_info.get("description") or None

                    # Thumbnail extraction
                    thumb = None
                    media_list = feed_info.get("media") or []
                    if media_list and isinstance(media_list, list) and isinstance(media_list[0], dict):
                        thumb = media_list[0].get("thumbUrl") or media_list[0].get("coverUrl")
                    if not thumb:
                        thumb = feed_info.get("coverUrl") or feed_info.get("thumbUrl")

                    published_at = None
                    createtime = feed_info.get("createtime")
                    if createtime and isinstance(createtime, (int, float)):
                        try:
                            dt = datetime.datetime.fromtimestamp(createtime, datetime.timezone.utc)
                            published_at = dt.strftime("%Y-%m-%d")
                        except Exception:
                            pass

                    like_cnt = scene_info.get("likeCount")
                    comment_cnt = scene_info.get("commentCount")
                    forward_cnt = scene_info.get("forwardCount")
                    fav_cnt = scene_info.get("favCount")

                    meta = ContentMetadataV1(
                        schema_version=1,
                        source_type="weixin",
                        source_url=url,
                        canonical_url=canonical_url or url,
                        source_id=sph_id,
                        title=title,
                        description=feed_info.get("description"),
                        creator=author_name,
                        published_at=published_at,
                        thumbnail_url=thumb,
                        like_count=like_cnt,
                        comment_count=comment_cnt,
                        platform_metadata={
                            "fav_count": fav_cnt,
                            "forward_count": forward_cnt,
                            "dynamic_export_id": feed_info.get("dynamicExportId"),
                            "author_avatar": author_info.get("headUrl"),
                        },
                    )

                    return self.build_outcome(
                        metadata=meta,
                        strategy_name="weixin_preview",
                        fetch_status="ok",
                        http_status=res.http_status,
                        code=None,
                    )
            except Exception:
                pass

        # API failed or returned non-zero errCode; fallback to GenericStaticStrategy
        return self.fallback_strategy.resolve(url, source_type, source_id, canonical_url)
