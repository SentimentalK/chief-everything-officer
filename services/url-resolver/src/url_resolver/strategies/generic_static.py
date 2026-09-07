"""
Generic static resolution strategy using ScraplingStaticFetcher and GenericMetadataParser.
Default strategy for YouTube, Bilibili, articles, and generic websites.
"""

from typing import Optional
from ..fetch import FetchResult, ScraplingStaticFetcher, WebFetcher
from ..models import ContentMetadataV1, ResolutionOutcome
from ..parser.embedded.bilibili import parse_bilibili_initial_state
from ..parser.generic import GenericMetadataParser
from .base import BaseStrategy


class GenericStaticStrategy(BaseStrategy):
    """
    Resolves public metadata by statically fetching the page with TLS impersonation
    and extracting standard OpenGraph, Twitter, and JSON-LD metadata.
    """

    def __init__(self, fetcher: Optional[WebFetcher] = None):
        self.fetcher = fetcher or ScraplingStaticFetcher()

    def resolve(
        self,
        url: str,
        source_type: str,
        source_id: Optional[str] = None,
        canonical_url: Optional[str] = None,
    ) -> ResolutionOutcome:
        fetch_res: FetchResult = self.fetcher.fetch_url(url)

        # Baseline metadata containing known identity
        meta = ContentMetadataV1(
            schema_version=1,
            source_type=source_type,
            source_url=url,
            canonical_url=canonical_url or fetch_res.final_url or url,
            source_id=source_id,
        )

        # Handle blocked or failed fetch
        if fetch_res.blocked or fetch_res.http_status != 200:
            code = "ACCESS_BLOCKED"
            fetch_status = "blocked"

            reason = (fetch_res.block_reason or "").upper()
            if "TIMEOUT" in reason:
                code = "TIMEOUT"
                fetch_status = "timeout"
            elif "NETWORK_ERROR" in reason:
                code = "NETWORK_ERROR"
                fetch_status = "network_error"
            elif fetch_res.http_status == 429:
                code = "RATE_LIMITED"

            return self.build_outcome(
                metadata=meta,
                strategy_name="generic_static",
                fetch_status=fetch_status,
                http_status=fetch_res.http_status if fetch_res.http_status > 0 else None,
                code=code,
            )

        # Parse generic metadata
        parsed_fields, _ = GenericMetadataParser.parse(fetch_res.body)

        # Optional embedded parser enrichment (Bilibili __INITIAL_STATE__)
        if source_type == "bilibili":
            embedded = parse_bilibili_initial_state(fetch_res.body)
            for k, v in embedded.items():
                if v is not None and (parsed_fields.get(k) is None):
                    parsed_fields[k] = v

        # Populate observable metadata fields
        for field, value in parsed_fields.items():
            if hasattr(meta, field) and value is not None:
                setattr(meta, field, value)

        return self.build_outcome(
            metadata=meta,
            strategy_name="generic_static",
            fetch_status="ok",
            http_status=fetch_res.http_status,
            code=None,
        )
