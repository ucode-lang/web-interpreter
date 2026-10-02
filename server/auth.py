"""GitHub login and session cookies.

Two auth modes, chosen by environment:

  github  -- GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET are set. Users sign in
             through GitHub's web application flow; optionally restricted to
             members of one organisation (GITHUB_ORG).
  local   -- nothing configured: one implicit user, no login. This is the
             ./serve.py development mode.

Sessions are stateless: an HMAC-signed cookie holding the user id and an
expiry, so the app server stays free of session storage and restarts do not
log anybody out as long as SECRET_KEY is stable.

The GITHUB_WEB_BASE / GITHUB_API_BASE overrides exist for tests; point them
at a stub server to exercise the whole flow without GitHub.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from urllib import request as urlrequest
from urllib.parse import quote, urlencode

SESSION_COOKIE = "ucodepen_session"
OAUTH_COOKIE = "ucodepen_oauth"
SESSION_TTL = 30 * 86400
OAUTH_TTL = 600

DEFAULT_WEB_BASE = "https://github.com"
DEFAULT_API_BASE = "https://api.github.com"


class Auth:
    """Configuration + the GitHub side of the flow. Instantiated once per
    server; per-request state (the CSRF token) travels in a cookie."""

    def __init__(self, env=None):
        env = env if env is not None else os.environ
        self.client_id = env.get("GITHUB_CLIENT_ID", "").strip()
        self.client_secret = env.get("GITHUB_CLIENT_SECRET", "").strip()
        self.org = env.get("GITHUB_ORG", "").strip()
        self.web_base = (env.get("GITHUB_WEB_BASE") or DEFAULT_WEB_BASE).rstrip("/")
        self.api_base = (env.get("GITHUB_API_BASE") or DEFAULT_API_BASE).rstrip("/")
        self.secret = (env.get("SECRET_KEY") or "").strip()
        self.mode = "github" if self.client_id and self.client_secret else "local"

        if self.mode == "github" and not self.secret:
            # Sessions would be forgeable without a secret; a random one keeps
            # the server safe (at the cost of logouts on restart).
            self.secret = secrets.token_hex(32)

    # -- sessions ---------------------------------------------------------

    def issue_session(self, user: dict) -> str:
        # The profile travels inside the cookie so /api/me needs no storage
        # round-trip; only the id is security-relevant.
        payload = {"uid": user["id"], "login": user["login"],
                   "name": user.get("name"), "avatar": user.get("avatar_url"),
                   "exp": int(time.time()) + SESSION_TTL}

        return self._sign(json.dumps(payload, separators=(",", ":")))

    def read_session(self, token: str):
        """Return the user id, or None when the cookie is missing, forged or
        stale."""

        if not token:
            return None

        try:
            payload_b64, signature = token.rsplit(".", 1)
            payload = _b64decode(payload_b64)

            if not hmac.compare_digest(self._signature(payload), signature):
                return None

            data = json.loads(payload)

            if data.get("exp", 0) < time.time():
                return None

            return int(data["uid"])
        except (ValueError, KeyError, TypeError):
            return None

    def _sign(self, payload: str) -> str:
        encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")

        return f"{encoded}.{self._signature(payload)}"

    def _signature(self, payload: str) -> str:
        return hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    # -- github web application flow --------------------------------------

    def authorize_url(self, state: str, redirect_uri: str) -> str:
        # read:org is what lets the user prove membership of GITHUB_ORG; with
        # no organisation restriction the app asks for no scope at all.
        query = urlencode({
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": "read:org" if self.org else "",
            "state": state,
        })

        return f"{self.web_base}/login/oauth/authorize?{query}"

    def exchange_code(self, code: str, redirect_uri: str):
        """Access token for a code, or None. The token never touches the
        browser: it is used server-side and then dropped."""

        # The token endpoint lives on the web domain; api.github.com no
        # longer serves it (404).
        body = self._post(f"{self.web_base}/login/oauth/access_token", {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        })

        return (body or {}).get("access_token")

    def fetch_user(self, token: str):
        return self._get(f"{self.api_base}/user", token)

    def org_membership(self, token: str) -> bool:
        """True when the signed-in user is a member of GITHUB_ORG. Always True
        when no organisation is configured."""

        if not self.org:
            return True

        profile = self._get(
            f"{self.api_base}/user/memberships/orgs/{quote(self.org)}", token)

        return bool(profile) and profile.get("state") == "active"

    # --

    def _get(self, url: str, token: str):
        req = urlrequest.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "ucodepen",
        })

        try:
            with urlrequest.urlopen(req, timeout=10) as res:
                return json.loads(res.read().decode("utf-8"))
        except (OSError, ValueError):
            return None

    def _post(self, url: str, fields: dict):
        data = urlencode(fields).encode()

        req = urlrequest.Request(url, data=data, headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "ucodepen",
        }, method="POST")

        try:
            with urlrequest.urlopen(req, timeout=10) as res:
                return json.loads(res.read().decode("utf-8"))
        except (OSError, ValueError):
            return None


def _b64decode(value: str) -> str:
    """urlsafe base64 without the padding the cookie format strips."""

    return base64.urlsafe_b64decode(value.encode() + b"===").decode()


def new_state() -> str:
    return secrets.token_urlsafe(16)


def safe_next(value: str) -> str:
    """Only same-site absolute paths survive; everything else falls back to
    the app, so the login redirect cannot be used to send users elsewhere."""

    if value and value.startswith("/") and not value.startswith("//"):
        return value

    return "/pen/"