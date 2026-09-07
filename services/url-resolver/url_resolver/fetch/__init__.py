"""
Internal web fetch abstractions and transport adapters.
"""

from .base import FetchRequest, FetchResult, WebFetcher
from .direct_http import DirectHttpFetcher
from .scrapling_static import ScraplingStaticFetcher

__all__ = [
    "DirectHttpFetcher",
    "FetchRequest",
    "FetchResult",
    "ScraplingStaticFetcher",
    "WebFetcher",
]
