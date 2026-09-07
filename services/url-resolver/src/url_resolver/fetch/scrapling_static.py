"""
Scrapling static fetcher implementation.
Uses ONLY the lightweight, static Scrapling Fetcher without browser processes.
"""

import time
from typing import Optional, Tuple
from scrapling.fetchers import Fetcher

from .base import FetchRequest, FetchResult, WebFetcher


class ScraplingStaticFetcher(WebFetcher):
    """
    Lightweight web fetcher backed by Scrapling's static Fetcher (TLS impersonation).
    Strictly zero browser processes, no Playwright/Patchright execution, no cookies.
    """

    def fetch(self, request: FetchRequest) -> FetchResult:
        start_t = time.time()
        timeout = int(request.timeout_seconds) if request.timeout_seconds else 15

        try:
            # Scrapling Fetcher.get executes lightweight request with curl-cffi TLS impersonation
            resp = Fetcher.get(
                request.url,
                headers=dict(request.headers) if request.headers else None,
                timeout=timeout,
            )
            latency_ms = int((time.time() - start_t) * 1000)

            html_content = getattr(resp, "html_content", None)
            if html_content is None:
                html_content = resp.text if hasattr(resp, "text") and isinstance(resp.text, str) else ""

            body = html_content or ""
            status = getattr(resp, "status", 200)
            final_url = str(getattr(resp, "url", request.url))

            content_type = None
            resp_headers = {}
            if hasattr(resp, "headers") and resp.headers:
                resp_headers = {str(k).lower(): str(v) for k, v in resp.headers.items()}
                content_type = resp_headers.get("content-type")

            is_blocked, block_reason = self._detect_block(body, status)

            return FetchResult(
                requested_url=request.url,
                final_url=final_url,
                http_status=status,
                content_type=content_type,
                headers=resp_headers,
                body=body,
                latency_ms=latency_ms,
                blocked=is_blocked,
                block_reason=block_reason,
            )
        except Exception as exc:
            latency_ms = int((time.time() - start_t) * 1000)
            err_str = str(exc)
            err_type = type(exc).__name__.lower()
            is_timeout = isinstance(exc, TimeoutError) or "timeout" in err_type or "timeout" in err_str.lower()
            return FetchResult(
                requested_url=request.url,
                final_url=request.url,
                http_status=0,
                content_type=None,
                headers={},
                body="",
                latency_ms=latency_ms,
                blocked=True,
                block_reason=f"TIMEOUT: {err_str}" if is_timeout else f"NETWORK_ERROR: {err_str}",
            )

    @staticmethod
    def _detect_block(body: str, status_code: int) -> Tuple[bool, Optional[str]]:
        """Identify anti-bot challenge or rate limiting pages."""
        if status_code == 412:
            return True, "HTTP 412 Precondition Failed (WAF Challenge)"
        if status_code == 403:
            return True, "HTTP 403 Forbidden"
        if status_code == 429:
            return True, "HTTP 429 Rate Limited"

        lower = (body or "").lower()
        if "sign in to confirm you’re not a bot" in lower or "sign in to confirm you're not a bot" in lower:
            return True, "YouTube Bot Challenge (Sign in required)"
        if "cf-chl-widget" in lower or ("cloudflare" in lower and "challenge" in lower and len(body) < 15000):
            return True, "Cloudflare Challenge"
        if "sec.bilibili.com" in lower or ("error 412" in lower and len(body) < 10000) or ("blendtrans" in lower and len(body) < 10000):
            return True, "Bilibili Risk Control / WAF Challenge"
        if len(body) < 4000 and ("captcha" in lower or "geetest" in lower):
            return True, "CAPTCHA Challenge"

        if not body or len(body.strip()) < 30:
            return True, f"Empty or tiny response body ({len(body)} bytes)"

        return False, None
