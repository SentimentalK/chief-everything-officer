"""
Data models and contracts for content.resolve_url.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, HttpUrl

# Observation fields used to evaluate resolution completeness.
# Identity fields (source_url, canonical_url, source_type, source_id, captured_at, schema_version)
# do NOT count toward fields_resolved or status="resolved".
METADATA_OBSERVATION_FIELDS = (
    "title",
    "description",
    "creator",
    "published_at",
    "duration_seconds",
    "language",
    "thumbnail_url",
    "view_count",
    "like_count",
    "comment_count",
)


class ContentMetadataV1(BaseModel):
    """Canonical V1 metadata contract for resolved content."""
    schema_version: int = Field(default=1, description="Contract schema version")
    source_type: str = Field(..., description="Platform identifier (youtube, bilibili, weixin, web, etc.)")
    source_url: str = Field(..., description="Requested source URL")
    canonical_url: Optional[str] = Field(default=None, description="Normalized or final canonical URL")
    source_id: Optional[str] = Field(default=None, description="Platform-specific content identifier")

    # Observable metadata fields (sparse, None if unavailable)
    title: Optional[str] = Field(default=None, description="Observed title")
    description: Optional[str] = Field(default=None, description="Observed description or summary")
    creator: Optional[str] = Field(default=None, description="Author / channel / uploader name")
    published_at: Optional[str] = Field(default=None, description="Publication date (YYYY-MM-DD or ISO 8601)")
    duration_seconds: Optional[int] = Field(default=None, description="Media duration in integer seconds")
    language: Optional[str] = Field(default=None, description="Primary content language code")
    thumbnail_url: Optional[str] = Field(default=None, description="Preview / thumbnail image URL")

    # Engagement statistics (sparse)
    view_count: Optional[Any] = Field(default=None, description="View count observation")
    like_count: Optional[Any] = Field(default=None, description="Like count observation")
    comment_count: Optional[Any] = Field(default=None, description="Comment count observation")

    captured_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="UTC timestamp when metadata was captured",
    )
    platform_metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Optional platform-specific raw dictionary",
    )


class Diagnostics(BaseModel):
    """Execution and transport diagnostics."""
    strategy: str = Field(..., description="Strategy name used for resolution")
    fetch_status: Literal["ok", "blocked", "timeout", "network_error"] = Field(
        ..., description="Transport fetch status"
    )
    http_status: Optional[int] = Field(default=None, description="HTTP status code received")
    code: Optional[str] = Field(default=None, description="Classification code e.g. ACCESS_BLOCKED, TIMEOUT")


class ResolutionOutcome(BaseModel):
    """Public outcome model for content.resolve_url."""
    status: Literal["resolved", "unavailable"] = Field(
        ..., description="Binary resolution status: resolved if >=1 observation field present, else unavailable"
    )
    fields_resolved: List[str] = Field(
        default_factory=list,
        description="List of observed non-null metadata field names (excluding identity fields)",
    )
    metadata: ContentMetadataV1 = Field(..., description="Sparse metadata payload")
    diagnostics: Diagnostics = Field(..., description="Resolution diagnostics")


class ResolveUrlInputV1(BaseModel):
    """Input payload for POST /v1/resolve."""
    schema_version: int = Field(default=1, description="Request schema version")
    url: str = Field(..., description="Target URL to resolve")


class ResolverValidationError(Exception):
    """Raised when URL or request input is malformed or invalid."""
    pass


class InvalidUrlError(ResolverValidationError):
    """Raised when URL syntax is invalid or unsupported."""
    pass


class UnsupportedProtocolError(ResolverValidationError):
    """Raised when URL scheme is not http or https."""
    pass


class ResolverInternalError(Exception):
    """Raised when an unrecoverable internal invariant violation occurs."""
    pass
