"""
YouTube oEmbed strategy with bounded fallback to GenericStaticStrategy.
"""

import json
import logging
import time
from typing import Any, Optional

from ..fetch import DirectHttpFetcher, FetchRequest, FetchResult, WebFetcher
from ..models import ContentMetadataV1, ResolutionOutcome
from .base import BaseStrategy
from .generic_static import GenericStaticStrategy

logger = logging.getLogger("url_resolver.strategies.youtube_oembed")


def _clean_str(val: Any) -> Optional[str]:
    """Return stripped string if non-empty, otherwise None."""
    if isinstance(val, str):
        s = val.strip()
        return s if s else None
    return None


class YoutubeOembedStrategy(BaseStrategy):
    """
    Specialized metadata resolution strategy for YouTube.
    Prioritizes the official, public, unauthenticated YouTube oEmbed endpoint
    (https://www.youtube.com/oembed) to bypass datacenter IP webpage challenges.
    Transparently and boundingly falls back to GenericStaticStrategy if needed.
    """

    API_URL = "https://www.youtube.com/oembed"

    def __init__(
        self,
        api_fetcher: Optional[WebFetcher] = None,
        fallback_strategy: Optional[BaseStrategy] = None,
        total_budget_seconds: float = 10.0,
        oembed_timeout_seconds: float = 4.0,
    ):
        self.api_fetcher = api_fetcher or DirectHttpFetcher()
        self.fallback_strategy = fallback_strategy or GenericStaticStrategy()
        self.total_budget_seconds = total_budget_seconds
        self.oembed_timeout_seconds = oembed_timeout_seconds

    def resolve(
        self,
        url: str,
        source_type: str,
        source_id: Optional[str] = None,
        canonical_url: Optional[str] = None,
    ) -> ResolutionOutcome:
        start_time = time.perf_counter()
        query_url = canonical_url or url

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json,text/plain,*/*",
        }

        req = FetchRequest(
            url=self.API_URL,
            method="GET",
            headers=headers,
            params={"url": query_url, "format": "json"},
            timeout_seconds=self.oembed_timeout_seconds,
        )

        oembed_failure_reason: Optional[str] = None
        partial_metadata: Optional[ContentMetadataV1] = None
        res: Optional[FetchResult] = None

        try:
            res = self.api_fetcher.fetch(req)
        except Exception as exc:
            oembed_failure_reason = f"fetch_exception: {type(exc).__name__}: {str(exc)}"

        if res and res.http_status == 200 and res.body:
            try:
                data = json.loads(res.body)
                if isinstance(data, dict):
                    title = _clean_str(data.get("title"))
                    creator = _clean_str(data.get("author_name"))
                    thumbnail_url = _clean_str(data.get("thumbnail_url"))

                    platform_meta = {
                        "author_url": _clean_str(data.get("author_url")),
                        "provider_name": _clean_str(data.get("provider_name")),
                        "type": _clean_str(data.get("type")),
                    }

                    if title:
                        meta = ContentMetadataV1(
                            schema_version=1,
                            source_type="youtube",
                            source_url=url,
                            canonical_url=canonical_url or url,
                            source_id=source_id,
                            title=title,
                            creator=creator,
                            thumbnail_url=thumbnail_url,
                            platform_metadata=platform_meta,
                        )
                        logger.debug("oEmbed succeeded for %s, title=%r", query_url, title)
                        return self.build_outcome(
                            metadata=meta,
                            strategy_name="youtube_oembed",
                            fetch_status="ok",
                            http_status=res.http_status,
                            code=None,
                        )

                    # Title missing, but other fields may be valid
                    if creator or thumbnail_url:
                        partial_metadata = ContentMetadataV1(
                            schema_version=1,
                            source_type="youtube",
                            source_url=url,
                            canonical_url=canonical_url or url,
                            source_id=source_id,
                            title=None,
                            creator=creator,
                            thumbnail_url=thumbnail_url,
                            platform_metadata=platform_meta,
                        )
                    oembed_failure_reason = "missing_title_in_oembed"
                else:
                    oembed_failure_reason = "oembed_response_not_dict"
            except (json.JSONDecodeError, ValueError, KeyError) as err:
                oembed_failure_reason = f"json_decode_error: {type(err).__name__}"
        elif res:
            oembed_failure_reason = (
                f"http_{res.http_status}" if res.http_status != 0 else (res.block_reason or "network_error")
            )

        # Evaluate remaining budget for fallback
        elapsed = time.perf_counter() - start_time
        remaining_budget = self.total_budget_seconds - elapsed

        logger.info(
            "oEmbed attempt for %s failed (%s); remaining_budget=%.2fs",
            query_url,
            oembed_failure_reason,
            remaining_budget,
        )

        if remaining_budget <= 0.5:
            logger.warning(
                "Timeout budget exhausted (%.2fs remaining), skipping fallback for %s",
                remaining_budget,
                query_url,
            )
            if partial_metadata:
                return self.build_outcome(
                    metadata=partial_metadata,
                    strategy_name="youtube_oembed",
                    fetch_status="ok",
                    http_status=res.http_status if res else None,
                    code=None,
                )
            empty_meta = ContentMetadataV1(
                schema_version=1,
                source_type="youtube",
                source_url=url,
                canonical_url=canonical_url or url,
                source_id=source_id,
            )
            return self.build_outcome(
                metadata=empty_meta,
                strategy_name="youtube_oembed",
                fetch_status="timeout",
                http_status=res.http_status if res else None,
                code="TIMEOUT",
            )

        # Enter fallback
        logger.info("Entering fallback strategy GenericStaticStrategy for %s", query_url)
        fallback_outcome = self.fallback_strategy.resolve(url, source_type, source_id, canonical_url)

        # If fallback succeeded and obtained a title (or resolved observation fields), prefer it
        if fallback_outcome.status == "resolved" and fallback_outcome.metadata.title:
            return fallback_outcome

        # If fallback was unavailable or missing title, but oEmbed yielded partial metadata, preserve it
        if partial_metadata:
            logger.info("Fallback did not yield title; preserving partial oEmbed metadata for %s", query_url)
            return self.build_outcome(
                metadata=partial_metadata,
                strategy_name="youtube_oembed",
                fetch_status="ok",
                http_status=res.http_status if res else None,
                code=None,
            )

        return fallback_outcome
