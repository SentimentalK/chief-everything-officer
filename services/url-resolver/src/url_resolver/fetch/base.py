"""
Core abstractions for web fetching.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional


@dataclass(frozen=True)
class FetchRequest:
    """Encapsulates request configuration for WebFetcher."""
    url: str
    method: Literal["GET", "POST"] = "GET"
    headers: Optional[Mapping[str, str]] = None
    params: Optional[Mapping[str, str]] = None
    json_body: Optional[Any] = None
    timeout_seconds: float = 15.0


@dataclass(frozen=True)
class FetchResult:
    """Normalized response returned by WebFetcher implementations."""
    requested_url: str
    final_url: str
    http_status: int
    content_type: Optional[str]
    headers: Mapping[str, str]
    body: str
    latency_ms: int
    blocked: bool = False
    block_reason: Optional[str] = None


class WebFetcher(ABC):
    """Abstract interface for lightweight HTTP fetching."""

    @abstractmethod
    def fetch(self, request: FetchRequest) -> FetchResult:
        """Execute the request and return a normalized FetchResult."""
        pass

    def fetch_url(self, url: str, timeout_seconds: float = 15.0) -> FetchResult:
        """Convenience method for simple GET requests."""
        return self.fetch(FetchRequest(url=url, method="GET", timeout_seconds=timeout_seconds))
