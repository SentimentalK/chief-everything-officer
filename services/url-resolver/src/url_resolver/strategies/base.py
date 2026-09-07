"""
Base strategy interface for URL resolution.
"""

from abc import ABC, abstractmethod
from typing import Optional
from ..models import ContentMetadataV1, Diagnostics, ResolutionOutcome, METADATA_OBSERVATION_FIELDS


class BaseStrategy(ABC):
    """Abstract base class for resolution strategies."""

    @abstractmethod
    def resolve(
        self,
        url: str,
        source_type: str,
        source_id: Optional[str] = None,
        canonical_url: Optional[str] = None,
    ) -> ResolutionOutcome:
        """Resolve metadata for the target URL."""
        pass

    @staticmethod
    def build_outcome(
        metadata: ContentMetadataV1,
        strategy_name: str,
        fetch_status: str,
        http_status: Optional[int] = None,
        code: Optional[str] = None,
    ) -> ResolutionOutcome:
        """
        Builds ResolutionOutcome.
        Computes fields_resolved from METADATA_OBSERVATION_FIELDS only.
        Identity fields (source_url, canonical_url, source_type, source_id, captured_at, schema_version)
        are excluded from fields_resolved.
        Status is 'resolved' if at least one observation field is non-None, otherwise 'unavailable'.
        """
        resolved_fields = [
            f for f in METADATA_OBSERVATION_FIELDS
            if getattr(metadata, f, None) is not None
        ]

        status = "resolved" if len(resolved_fields) > 0 else "unavailable"

        diagnostics = Diagnostics(
            strategy=strategy_name,
            fetch_status=fetch_status,
            http_status=http_status,
            code=code,
        )

        return ResolutionOutcome(
            status=status,
            fields_resolved=resolved_fields,
            metadata=metadata,
            diagnostics=diagnostics,
        )
