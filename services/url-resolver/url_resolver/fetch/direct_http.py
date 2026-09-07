"""
Direct HTTP fetcher backed by httpx for lightweight REST and API requests.
"""

import time
from typing import Optional, Tuple
import httpx

from .base import FetchRequest, FetchResult, WebFetcher


class DirectHttpFetcher(WebFetcher):
    """Standard HTTP fetcher using httpx.Client."""

    def fetch(self, request: FetchRequest) -> FetchResult:
        start_t = time.time()
        timeout = request.timeout_seconds or 15.0

        headers = dict(request.headers) if request.headers else {}
        if "user-agent" not in {k.lower(): k for k in headers}:
            headers["User-Agent"] = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            )

        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                if request.method == "POST":
                    resp = client.post(
                        request.url,
                        headers=headers,
                        params=dict(request.params) if request.params else None,
                        json=request.json_body,
                    )
                else:
                    resp = client.get(
                        request.url,
                        headers=headers,
                        params=dict(request.params) if request.params else None,
                    )

            latency_ms = int((time.time() - start_t) * 1000)
            status = resp.status_code
            body = resp.text
            final_url = str(resp.url)
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
            is_timeout = "timeout" in err_str.lower()
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
        if status_code == 412:
            return True, "HTTP 412 Precondition Failed"
        if status_code == 403:
            return True, "HTTP 403 Forbidden"
        if status_code == 429:
            return True, "HTTP 429 Rate Limited"
        if status_code >= 400:
            return True, f"HTTP Error {status_code}"
        return False, None
