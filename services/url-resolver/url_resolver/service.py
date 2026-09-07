"""
FastAPI HTTP microservice for the Content Resolver capability.
Provides /healthz, /readyz, and /v1/resolve with fail-closed token authentication,
structured single-line JSON logging, and request correlation.
"""

from contextlib import asynccontextmanager
import datetime
import json
import logging
import os
import re
import secrets
import sys
import time
from typing import Any, Optional
import urllib.parse
import uuid

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse

from .models import (
    InvalidUrlError,
    ResolutionOutcome,
    ResolveUrlInputV1,
    ResolverInternalError,
    ResolverValidationError,
    UnsupportedProtocolError,
)
from .resolver import resolve_url

# ============================================================================
# Probe Log Filtering
# ============================================================================

class ProbeEndpointFilter(logging.Filter):
    """
    Silences access logs for /healthz and /readyz only when HTTP status is exactly 200.
    Preserves errors (e.g. 503, 500), redirects (3xx), and non-probe requests.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn.access passes args: (client_addr, method, full_path, http_version, status_code)
        if record.args and len(record.args) >= 5:
            path = record.args[2]
            status_code = record.args[4]
            if path in ("/healthz", "/readyz") and status_code == 200:
                return False
        return True


# ============================================================================
# Structured Logging & Request Helpers
# ============================================================================

REQUEST_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SENSITIVE_PARAM_NAMES = {"token", "auth", "key", "secret", "sig", "password", "signature"}

logger = logging.getLogger("url_resolver.service")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setLevel(logging.INFO)
    _handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(_handler)
    logger.propagate = False


def extract_or_generate_request_id(request: Optional[Request]) -> str:
    """Retrieves valid X-Request-ID from request headers, or generates a new UUID4."""
    if request and hasattr(request, "headers"):
        req_id = request.headers.get("x-request-id", "").strip()
        if req_id and REQUEST_ID_REGEX.match(req_id):
            return req_id
    return str(uuid.uuid4())


def sanitize_url(url: str) -> str:
    """Removes user credentials and sensitive query tokens from URL for logging."""
    if not url or not isinstance(url, str):
        return ""
    try:
        parts = urllib.parse.urlsplit(url)
        netloc = parts.hostname or ""
        if parts.port:
            netloc = f"{netloc}:{parts.port}"

        if parts.query:
            query_params = []
            for item in parts.query.split("&"):
                if not item:
                    continue
                k = item.split("=")[0].lower()
                if k in SENSITIVE_PARAM_NAMES:
                    query_params.append(f"{item.split('=')[0]}=[REDACTED]")
                else:
                    query_params.append(item)
            query = "&".join(query_params)
        else:
            query = ""

        return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))
    except Exception:
        return url[:200]


def log_structured_event(level: int, event_data: dict) -> None:
    """Emits single-line JSON log entry with UTC ISO timestamp."""
    event_data["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        line = json.dumps(event_data, ensure_ascii=False)
    except Exception:
        line = json.dumps({k: str(v) for k, v in event_data.items()})
    logger.log(level, line)


# ============================================================================
# FastAPI Lifespan & Application Setup
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Set third-party loggers to WARNING to silence noisy internal info logs
    logging.getLogger("scrapling").setLevel(logging.WARNING)
    logging.getLogger("curl_cffi").setLevel(logging.WARNING)

    # Idempotently register probe filter on uvicorn.access
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, ProbeEndpointFilter) for f in access_logger.filters):
        access_logger.addFilter(ProbeEndpointFilter())
    for h in access_logger.handlers:
        if not any(isinstance(f, ProbeEndpointFilter) for f in h.filters):
            h.addFilter(ProbeEndpointFilter())
    yield


app = FastAPI(
    title="Content Resolver Service",
    description="Lightweight URL metadata resolution service for Tools monorepo.",
    version="0.2.0",
    lifespan=lifespan,
)


# ============================================================================
# Exception Handlers
# ============================================================================

@app.exception_handler(HTTPException)
async def custom_http_exception_handler(request: Request, exc: HTTPException):
    req_id = extract_or_generate_request_id(request)

    if exc.status_code == status.HTTP_401_UNAUTHORIZED:
        level = logging.WARNING
        res_status = "unauthorized"
        event_name = "resolve_rejected"
    elif exc.status_code == status.HTTP_400_BAD_REQUEST:
        level = logging.WARNING
        res_status = "invalid_url"
        event_name = "resolve_rejected"
    elif exc.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR and isinstance(exc.detail, dict) and exc.detail.get("code") == "auth_not_configured":
        level = logging.ERROR
        res_status = "server_misconfigured"
        event_name = "resolve_failed"
    else:
        level = logging.ERROR
        res_status = "error"
        event_name = "resolve_failed"

    detail_code = exc.detail.get("code") if isinstance(exc.detail, dict) else "http_error"
    detail_msg = exc.detail.get("message") if isinstance(exc.detail, dict) else str(exc.detail)

    log_structured_event(level, {
        "event": event_name,
        "request_id": req_id,
        "path": request.url.path,
        "http_status": exc.status_code,
        "resolution_status": res_status,
        "code": detail_code,
        "error": detail_msg[:200],
    })

    headers = dict(exc.headers) if exc.headers else {}
    headers["X-Request-ID"] = req_id
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=headers)


@app.exception_handler(RequestValidationError)
async def custom_validation_exception_handler(request: Request, exc: RequestValidationError):
    req_id = extract_or_generate_request_id(request)
    err_summary = "; ".join(f"{'.'.join(str(l) for l in err.get('loc', []))}: {err.get('msg')}" for err in exc.errors())[:200]

    log_structured_event(logging.WARNING, {
        "event": "resolve_rejected",
        "request_id": req_id,
        "path": request.url.path,
        "http_status": status.HTTP_422_UNPROCESSABLE_ENTITY,
        "resolution_status": "validation_error",
        "code": "validation_error",
        "error": err_summary,
    })

    response = await request_validation_exception_handler(request, exc)
    response.headers["X-Request-ID"] = req_id
    return response


@app.exception_handler(Exception)
async def custom_unhandled_exception_handler(request: Request, exc: Exception):
    req_id = extract_or_generate_request_id(request)

    log_structured_event(logging.ERROR, {
        "event": "resolve_failed",
        "request_id": req_id,
        "path": request.url.path,
        "http_status": status.HTTP_500_INTERNAL_SERVER_ERROR,
        "resolution_status": "error",
        "code": "internal_error",
        "error": str(exc)[:200],
    })

    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": {"code": "internal_error", "message": str(exc)}},
        headers={"X-Request-ID": req_id},
    )


# ============================================================================
# Core Endpoints & Auth
# ============================================================================

def get_configured_token() -> Optional[str]:
    """Retrieve internal token from environment."""
    token = os.environ.get("TOOLS_INTERNAL_TOKEN", "").strip()
    return token if token else None


def verify_auth_token(authorization: Optional[str] = Header(None)) -> None:
    """Verifies Bearer token against TOOLS_INTERNAL_TOKEN."""
    configured = get_configured_token()
    if not configured:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "auth_not_configured", "message": "Server authentication token is not configured."},
        )

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Missing Authorization header."},
            headers={"WWW-Authenticate": "Bearer"},
        )

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Invalid Authorization scheme, expected 'Bearer <token>'."},
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = parts[1]
    if not secrets.compare_digest(token, configured):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Invalid authentication token."},
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.get("/healthz", summary="Liveness probe")
def healthz(response: Response, request: Request):
    """Returns 200 if the service process is alive."""
    req_id = extract_or_generate_request_id(request)
    response.headers["X-Request-ID"] = req_id
    return {"status": "ok"}


@app.get("/readyz", summary="Readiness probe")
def readyz(response: Response, request: Request):
    """
    Returns 200 if the service is configured and ready to accept traffic.
    Fails closed (503) if TOOLS_INTERNAL_TOKEN is missing or invalid.
    """
    req_id = extract_or_generate_request_id(request)
    response.headers["X-Request-ID"] = req_id
    token = get_configured_token()
    if not token:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not_ready", "error": "TOOLS_INTERNAL_TOKEN is not configured"}
    return {"status": "ready"}


@app.post(
    "/v1/resolve",
    response_model=ResolutionOutcome,
    summary="Resolve URL metadata",
)
def resolve_endpoint(
    req: ResolveUrlInputV1,
    request: Request,
    response: Response,
    authorization: Optional[str] = Header(None),
):
    """
    Resolve public metadata for the provided URL.
    Returns structured ResolutionOutcome (status='resolved' | 'unavailable').
    """
    req_id = extract_or_generate_request_id(request)
    response.headers["X-Request-ID"] = req_id

    verify_auth_token(authorization)

    start_time = time.perf_counter()
    clean_url = sanitize_url(req.url)

    try:
        outcome = resolve_url(req.url)
    except ResolverValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_url", "message": str(e)},
        ) from e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "internal_error", "message": str(e)},
        ) from e

    latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
    diag = outcome.diagnostics
    meta = outcome.metadata

    title_trunc = (meta.title[:100] if meta.title else None)
    creator_trunc = (meta.creator[:50] if meta.creator else None)

    event_payload = {
        "event": "resolve_complete",
        "request_id": req_id,
        "url": clean_url,
        "source_type": meta.source_type,
        "source_id": meta.source_id,
        "http_status": status.HTTP_200_OK,
        "resolution_status": outcome.status,
        "strategy": diag.strategy,
        "fetch_status": diag.fetch_status,
        "upstream_http_status": diag.http_status,
        "latency_ms": latency_ms,
        "fields_resolved": outcome.fields_resolved,
        "title": title_trunc,
        "creator": creator_trunc,
        "code": diag.code,
    }

    if outcome.status == "resolved":
        log_structured_event(logging.INFO, event_payload)
    else:
        log_structured_event(logging.WARNING, event_payload)

    return outcome
