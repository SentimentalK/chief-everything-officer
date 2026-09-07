"""
Public Python entrypoint for content.resolve_url.
"""

from typing import Optional
from .models import ResolutionOutcome
from .router import ResolverRouter

_default_router: Optional[ResolverRouter] = None


def get_default_router() -> ResolverRouter:
    global _default_router
    if _default_router is None:
        _default_router = ResolverRouter()
    return _default_router


def resolve_url(url: str, router: Optional[ResolverRouter] = None) -> ResolutionOutcome:
    """
    Lightweight, synchronous metadata resolution capability for public URLs.
    Guaranteed zero browser execution, zero cookies, zero ASR.
    Returns structured ResolutionOutcome (status='resolved' | 'unavailable').
    """
    r = router or get_default_router()
    normalized_url = r.validate_and_normalize(url)
    source_type, source_id, canonical_url = r.identify(normalized_url)
    strategy = r.route(normalized_url)

    return strategy.resolve(
        url=normalized_url,
        source_type=source_type,
        source_id=source_id,
        canonical_url=canonical_url,
    )
