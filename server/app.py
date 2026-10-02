"""ucodepen's HTTP server: static files, the pen API, GitHub login.

    python3 -m server [port]            # HOST env overrides the bind address

Runs out of the standard library alone; the only optional dependency is the
pg8000 driver used when DATABASE_URL points at Postgres. Without it (and
without GitHub credentials) this is the plain development server: pens in
pens/, no login.

    GET    /api/me                 -> {store, mode, authenticated, user}
    GET    /login                  -> redirect to GitHub (github mode)
    GET    /api/auth/callback      -> GitHub redirects back here
    GET    /logout                 -> clears the session
    GET    /api/pens               -> the signed-in user's pens
    GET    /api/pens/<id>          -> one pen (public: ids are unguessable)
    PUT    /api/pens/<id>          -> create/update, owned by the caller
    DELETE /api/pens/<id>          -> remove, owned by the caller
    GET    /p/<id>                 -> redirect to /pen/#pen=<id>
"""

from __future__ import annotations

import hmac
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .auth import OAUTH_COOKIE, SESSION_COOKIE, OAUTH_TTL, Auth, new_state, safe_next
from .store import open_store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
PENS = os.path.join(ROOT, "pens")
ID_RE = re.compile(r"^[a-z0-9]{3,32}$")
MAX_BODY = 4 * 1024 * 1024


class App:
    """Everything the handler needs: config, store, auth. Built once in
    main() and shared across request threads."""

    def __init__(self, env=None):
        env = env if env is not None else os.environ
        self.auth = Auth(env)
        self.store = open_store(env.get("DATABASE_URL") or None,
                                env.get("PENS_DIR") or PENS)
        self.base_url = (env.get("BASE_URL") or "").rstrip("/")

    # --

    def redirect_uri(self, handler) -> str:
        if self.base_url:
            return f"{self.base_url}/api/auth/callback"

        host = handler.headers.get("Host") or "localhost"
        scheme = "https" if handler.headers.get("X-Forwarded-Proto") == "https" else "http"

        return f"{scheme}://{host}/api/auth/callback"

    def is_secure(self, handler) -> bool:
        if self.base_url.startswith("https"):
            return True

        return handler.headers.get("X-Forwarded-Proto") == "https"


class Handler(SimpleHTTPRequestHandler):
    app: App = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    # -- responses --------------------------------------------------------

    def json_out(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")

        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(body)

    def problem(self, code: int, message: str) -> None:
        self.json_out(code, {"error": message})

    def redirect(self, location: str, cookies=()) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")

        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)

        self.end_headers()

    def page(self, code: int, title: str, message: str) -> None:
        body = f"""<!doctype html><meta charset="utf-8">
<title>{title}</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 20px">
<h1>{title}</h1><p>{message}</p>
<p><a href="/pen/">back to the pen</a></p>""".encode("utf-8")

        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(body)

    # -- cookies ----------------------------------------------------------

    def cookie(self, name: str):
        header = self.headers.get("Cookie") or ""

        for part in header.split(";"):
            key, _, value = part.strip().partition("=")

            if key == name:
                return unquote(value)

        return None

    def set_cookie(self, name: str, value: str, max_age: int) -> str:
        parts = [f"{name}={value}", "Path=/", f"Max-Age={max_age}",
                 "HttpOnly", "SameSite=Lax"]

        if self.app.is_secure(self):
            parts.append("Secure")

        return "; ".join(parts)

    def clear_cookie(self, name: str) -> str:
        return f"{name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"

    def session_user(self):
        """The signed-in user's profile from the cookie, or None."""

        uid = self.app.auth.read_session(self.cookie(SESSION_COOKIE) or "")

        if uid is None:
            return None

        # The profile is part of the signed payload, so it can be trusted
        # without a storage round-trip.
        try:
            from .auth import _b64decode

            token = self.cookie(SESSION_COOKIE)
            data = json.loads(_b64decode(token.rsplit(".", 1)[0]))

            return {"id": data["uid"], "login": data["login"],
                    "name": data.get("name"), "avatar_url": data.get("avatar")}
        except (ValueError, KeyError, TypeError):
            return None

    def require_user(self):
        """The user acting on pens, or None with a 401 already sent. Local
        mode has no login: everybody is the same implicit user."""

        if self.app.auth.mode == "local":
            return {"id": 0, "login": "local", "name": None, "avatar_url": None}

        user = self.session_user()

        if user is None:
            self.problem(401, "sign in first (github mode is enabled on this server)")

        return user

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        path = urlsplit(self.path).path
        query = parse_qs(urlsplit(self.path).query)

        if path == "/api/me":
            user = self.session_user()
            self.json_out(200, {
                "store": "server",
                "mode": self.app.auth.mode,
                "authenticated": user is not None,
                "user": None if user is None else {
                    "login": user["login"], "name": user["name"],
                    "avatar_url": user["avatar_url"],
                },
            })
            return

        if path == "/login":
            if self.app.auth.mode != "github":
                self.redirect("/pen/")
                return

            state = new_state()
            cookies = [self.set_cookie(OAUTH_COOKIE, state, OAUTH_TTL)]
            self.redirect(self.app.auth.authorize_url(
                state, self.app.redirect_uri(self)), cookies)
            return

        if path == "/api/auth/callback":
            self.oauth_callback(query)
            return

        if path == "/logout":
            self.redirect(safe_next((query.get("next") or ["/pen/"])[0]),
                          [self.clear_cookie(SESSION_COOKIE)])
            return

        if path == "/api/pens":
            user = self.require_user()

            if user is None:
                return

            with storage(self):
                pens = self.app.store.list_pens(user["id"])

            self.json_out(200, {"store": "server", "pens": pens})
            return

        m = re.match(r"^/api/pens/([a-z0-9]+)$", path)

        if m:
            with storage(self):
                pen = self.app.store.get_pen(m.group(1))

            if pen is None:
                self.problem(404, f"no pen {m.group(1)}")
            else:
                self.json_out(200, pen["doc"])

            return

        if path.startswith("/p/"):
            pen_id = path[3:].strip("/")

            if ID_RE.match(pen_id):
                self.redirect(f"/pen/#pen={quote(pen_id)}")
            else:
                self.problem(400, "bad pen id")

            return

        if path == "/pen":
            self.redirect("/pen/")
            return

        super().do_GET()

    do_HEAD = do_GET

    def do_PUT(self):
        m = re.match(r"^/api/pens/([a-z0-9]+)$", urlsplit(self.path).path)

        if not m:
            self.problem(404, "expected /api/pens/<id>")
            return

        user = self.require_user()

        if user is None:
            return

        pen_id = m.group(1)

        if not ID_RE.match(pen_id):
            self.problem(400, "pen ids are 3-32 lowercase letters or digits")
            return

        length = int(self.headers.get("Content-Length") or 0)

        if length <= 0 or length > MAX_BODY:
            self.problem(400, f"body must be between 1 and {MAX_BODY} bytes")
            return

        try:
            pen = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            self.problem(400, f"invalid JSON: {exc}")
            return

        error = validate(pen)

        if error:
            self.problem(422, error)
            return

        with storage(self):
            existing = self.app.store.get_pen(pen_id)

        if existing and existing["owner_id"] != user["id"]:
            # The id came from somebody else's share link: saving under it
            # would silently overwrite their work.
            self.problem(403, "this pen belongs to another user -- duplicate it instead")
            return

        with storage(self):
            self.app.store.put_pen(user["id"], pen_id, pen)

        self.json_out(200, {"id": pen_id, "ok": True, "name": pen.get("name")})

    def do_DELETE(self):
        m = re.match(r"^/api/pens/([a-z0-9]+)$", urlsplit(self.path).path)

        if not m:
            self.problem(404, "expected /api/pens/<id>")
            return

        user = self.require_user()

        if user is None:
            return

        with storage(self):
            deleted = self.app.store.delete_pen(user["id"], m.group(1))

        if not deleted:
            self.problem(404, f"no pen {m.group(1)}")
            return

        self.json_out(200, {"ok": True})

    # -- the github callback ---------------------------------------------

    def oauth_callback(self, query: dict) -> None:
        auth = self.app.auth

        if auth.mode != "github":
            self.problem(404, "login is not configured on this server")
            return

        # GitHub reports the user's own refusal through ?error=.
        if query.get("error"):
            self.page(200, "login cancelled",
                      "GitHub reported: " + quote(query["error"][0]))
            return

        code = (query.get("code") or [None])[0]
        state = (query.get("state") or [None])[0]
        cookie_state = self.cookie(OAUTH_COOKIE)

        if not code or not state or not cookie_state \
                or not hmac.compare_digest(state, cookie_state):
            self.page(400, "login failed", "the login request could not be verified (state mismatch). Start again.")
            return

        token = auth.exchange_code(code, self.app.redirect_uri(self))

        if not token:
            self.page(502, "login failed", "GitHub did not accept the login code. Try again.")
            return

        profile = auth.fetch_user(token)

        if not profile or "id" not in profile:
            self.page(502, "login failed", "could not read the GitHub profile. Try again.")
            return

        if not auth.org_membership(token):
            self.page(403, "not allowed",
                      f"this instance only accepts members of the "
                      f"<b>{auth.org}</b> GitHub organisation, and your account "
                      f"({profile.get('login')}) is not one of them.")
            return

        # The access token was needed only for the two calls above; it is
        # dropped here and never stored.
        user = self.app.store.upsert_user({
            "id": profile["id"], "login": profile.get("login"),
            "name": profile.get("name"), "avatar_url": profile.get("avatar_url"),
        })

        self.redirect(safe_next((query.get("next") or ["/pen/"])[0]), [
            self.set_cookie(SESSION_COOKIE, auth.issue_session(user), 30 * 86400),
            self.clear_cookie(OAUTH_COOKIE),
        ])

    # -- misc -------------------------------------------------------------

    def end_headers(self):
        # the wasm and the js change together during development
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class storage:
    """Turn storage failures into a JSON 500 instead of a stack trace that
    kills the connection."""

    def __init__(self, handler):
        self.handler = handler

    def __enter__(self):
        return self

    def __exit__(self, kind, value, tb):
        if kind is None:
            return False

        self.handler.problem(500, f"storage error: {value}")
        return True


def validate(pen) -> str | None:
    """Return a problem description, or None when the document is usable."""
    if not isinstance(pen, dict):
        return "pen must be a JSON object"

    files = pen.get("files")

    if not isinstance(files, list) or not files:
        return "pen needs a non-empty 'files' array"

    if len(files) > 64:
        return "too many files (64 max)"

    for f in files:
        if not isinstance(f, dict) or not isinstance(f.get("name"), str):
            return "each file needs a 'name'"

        name = f["name"]

        if not re.match(r"^[\w][\w. -]{0,95}$", name) or ".." in name:
            return f"unacceptable file name {name!r}"

        if not isinstance(f.get("content", ""), str):
            return f"file {name!r} needs string content"

    if len(pen.get("name", "")) > 120:
        return "pen name too long"

    return None


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    port = int(argv[0]) if argv else int(os.environ.get("PORT") or 8000)
    host = os.environ.get("HOST") or "127.0.0.1"

    app = App()
    Handler.app = app

    if not os.path.isdir(WEB):
        print(f"error: {WEB} does not exist (run ./build.sh first)", file=sys.stderr)
        return 1

    if not os.path.exists(os.path.join(WEB, "ucode.wasm")):
        print("warning: web/ucode.wasm is missing -- run ./build.sh", file=sys.stderr)

    if app.auth.mode == "github":
        scope = f", members of {app.auth.org} only" if app.auth.org else ""
        print(f"  login  -> github ({app.auth.client_id[:8]}...{scope})")
    else:
        print("  login  -> local mode (no github credentials configured)")

    with ThreadingHTTPServer((host, port), Handler) as httpd:
        print(f"ucodepen on http://{host}:{port}/pen/")
        print("  ctrl-c to stop")

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")

    app.store.close()

    return 0