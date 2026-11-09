#!/usr/bin/env python3
"""SigV4 DELETE for DeleteCapacityProviderSession.

Used when the installed AWS CLI is older than the operation
`bedrock-agentcore delete-capacity-provider-session` (CLI 2.36+).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    k_date = _sign(("AWS4" + secret).encode("utf-8"), datestamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()


def main() -> int:
    provider_id = sys.argv[1] if len(sys.argv) > 1 else ""
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not provider_id or not session_id:
        print("usage: delete_capacity_provider_session.py <capacity-provider-id> <session-id>", file=sys.stderr)
        return 2

    access = os.environ.get("AWS_ACCESS_KEY_ID", "")
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    token = os.environ.get("AWS_SESSION_TOKEN", "")
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"
    if not access or not secret:
        print("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required.", file=sys.stderr)
        return 2

    service = "bedrock-agentcore"
    host = f"bedrock-agentcore.{region}.amazonaws.com"
    quoted_provider = urllib.parse.quote(provider_id, safe="-._~")
    quoted_session = urllib.parse.quote(session_id, safe="-._~")
    path = f"/capacity-providers/{quoted_provider}/sessions/{quoted_session}"

    now = dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()

    header_pairs = [("host", host), ("x-amz-content-sha256", payload_hash), ("x-amz-date", amz_date)]
    if token:
        header_pairs.append(("x-amz-security-token", token))
    header_pairs.sort()
    canonical_headers = "".join(f"{key}:{value}\n" for key, value in header_pairs)
    signed_headers = ";".join(key for key, _ in header_pairs)
    canonical_request = "\n".join(
        ["DELETE", path, "", canonical_headers, signed_headers, payload_hash]
    )
    credential_scope = f"{datestamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret, datestamp, region, service),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {key: value for key, value in header_pairs}
    headers["Authorization"] = authorization
    request = urllib.request.Request(
        f"https://{host}{path}",
        method="DELETE",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
            print(body or f"HTTP {response.status}")
            return 0
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {detail}", file=sys.stderr)
        if exc.code == 404:
            return 0
        return 1


if __name__ == "__main__":
    sys.exit(main())
