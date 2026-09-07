"""
url-resolver: Lightweight URL metadata resolution capability.
"""

from .models import (
    ContentMetadataV1,
    Diagnostics,
    InvalidUrlError,
    ResolutionOutcome,
    ResolverInternalError,
    ResolverValidationError,
    UnsupportedProtocolError,
)
from .resolver import resolve_url

__all__ = [
    "ContentMetadataV1",
    "Diagnostics",
    "InvalidUrlError",
    "ResolutionOutcome",
    "ResolverInternalError",
    "ResolverValidationError",
    "UnsupportedProtocolError",
    "resolve_url",
]
