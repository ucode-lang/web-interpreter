"""Storage backends for pens and users.

Two backends behind one small interface:

  PostgresStore  -- the deployment backend (DATABASE_URL, pg8000 driver)
  FileStore      -- the zero-dependency development backend (pens/*.json)

The interface:

  upsert_user(profile) -> user row          # profile: {id, login, name, avatar_url}
  list_pens(user_id) -> [meta]              # meta: {id, name, updated, files}
  get_pen(pen_id) -> {doc, owner_id} | None # public read; ownership checked by caller
  put_pen(user_id, pen_id, doc) -> None     # upsert, owned by user_id
  delete_pen(user_id, pen_id) -> bool       # True when this user's pen was removed
  close()
"""

from __future__ import annotations

import json
import os
import re
import time
from urllib.parse import urlsplit

ID_RE = re.compile(r"^[a-z0-9]{3,32}$")


class FileStore:
    """Pens as plain JSON files under one directory. Local mode only: every
    visitor is the same implicit user, so ownership is not modelled."""

    def __init__(self, root: str):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def upsert_user(self, profile: dict) -> dict:
        return {"id": 0, "login": profile.get("login") or "local",
                "name": profile.get("name"), "avatar_url": profile.get("avatar_url")}

    def list_pens(self, user_id: int) -> list:
        out = []

        for name in os.listdir(self.root):
            if not name.endswith(".json"):
                continue

            pen_id = name[:-5]

            if not ID_RE.match(pen_id):
                continue

            doc = self._read(pen_id)

            if doc is None:
                continue

            out.append({"id": pen_id, "name": doc.get("name") or pen_id,
                        "updated": os.path.getmtime(self._path(pen_id)),
                        "files": len(doc.get("files") or [])})

        out.sort(key=lambda p: p["updated"], reverse=True)

        return out

    def get_pen(self, pen_id: str):
        doc = self._read(pen_id)

        return None if doc is None else {"doc": doc, "owner_id": 0}

    def put_pen(self, user_id: int, pen_id: str, doc: dict) -> None:
        tmp = self._path(pen_id) + ".tmp"

        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)

        os.replace(tmp, self._path(pen_id))

    def delete_pen(self, user_id: int, pen_id: str) -> bool:
        try:
            os.remove(self._path(pen_id))
        except OSError:
            return False

        return True

    def close(self) -> None:
        pass

    # --

    def _path(self, pen_id: str) -> str:
        return os.path.join(self.root, f"{pen_id}.json")

    def _read(self, pen_id: str):
        if not ID_RE.match(pen_id):
            return None

        try:
            with open(self._path(pen_id), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None


class PostgresStore:
    """Pens in Postgres. One row per pen, the whole document as JSONB, so the
    file model can evolve without migrations. Requires the pure-python pg8000
    driver (pip install pg8000); imported lazily so the file store works
    without it."""

    def __init__(self, database_url: str):
        import pg8000.dbapi  # noqa: deferred: only needed for this backend

        parts = urlsplit(database_url)
        self.conn = pg8000.dbapi.Connection(
            user=parts.username or "postgres",
            password=parts.password or "",
            host=parts.hostname or "localhost",
            port=parts.port or 5432,
            database=parts.path.lstrip("/") or "ucodepen",
        )
        self._init_schema()

    def _init_schema(self) -> None:
        self._run("""
            CREATE TABLE IF NOT EXISTS users (
                id         BIGINT PRIMARY KEY,
                login      TEXT NOT NULL,
                name       TEXT,
                avatar_url TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        self._run("""
            CREATE TABLE IF NOT EXISTS pens (
                id         TEXT PRIMARY KEY,
                user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name       TEXT NOT NULL DEFAULT 'untitled',
                data       JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        self._run("CREATE INDEX IF NOT EXISTS pens_user_idx ON pens (user_id, updated_at DESC)")

        # local mode (no login) writes pens under the implicit user id 0
        self._run("""
            INSERT INTO users (id, login) VALUES (0, 'local')
            ON CONFLICT (id) DO NOTHING
        """)
        self.conn.commit()

    # -- users ------------------------------------------------------------

    def upsert_user(self, profile: dict) -> dict:
        rows = self._run("""
            INSERT INTO users (id, login, name, avatar_url)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE
                SET login = EXCLUDED.login, name = EXCLUDED.name,
                    avatar_url = EXCLUDED.avatar_url, updated_at = now()
            RETURNING id, login, name, avatar_url
        """, (int(profile["id"]), profile.get("login") or "",
              profile.get("name"), profile.get("avatar_url")), fetch=True)

        return {"id": rows[0][0], "login": rows[0][1],
                "name": rows[0][2], "avatar_url": rows[0][3]}

    # -- pens -------------------------------------------------------------

    def list_pens(self, user_id: int) -> list:
        rows = self._run("""
            SELECT id, name, EXTRACT(EPOCH FROM updated_at),
                   COALESCE(jsonb_array_length(data->'files'), 0)
            FROM pens WHERE user_id = %s ORDER BY updated_at DESC
        """, (user_id,), fetch=True)

        return [{"id": r[0], "name": r[1], "updated": float(r[2]), "files": int(r[3])} for r in rows]

    def get_pen(self, pen_id: str):
        rows = self._run(
            "SELECT data, user_id FROM pens WHERE id = %s", (pen_id,), fetch=True)

        if not rows:
            return None

        data = rows[0][0]

        return {"doc": json.loads(data) if isinstance(data, str) else data,
                "owner_id": rows[0][1]}

    def put_pen(self, user_id: int, pen_id: str, doc: dict) -> None:
        payload = json.dumps(doc, ensure_ascii=False)

        self._run("""
            INSERT INTO pens (id, user_id, name, data)
            VALUES (%s, %s, %s, %s::jsonb)
            ON CONFLICT (id) DO UPDATE
                SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()
        """, (pen_id, user_id, doc.get("name") or "untitled", payload))

    def delete_pen(self, user_id: int, pen_id: str) -> bool:
        n = self._run("DELETE FROM pens WHERE id = %s AND user_id = %s",
                      (pen_id, user_id), count=True)

        return n > 0

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    # --

    def _run(self, sql: str, params=(), fetch=False, count=False):
        """One statement, committed. A failed statement would poison the
        transaction for every later request, so errors roll back before they
        propagate."""

        cursor = self.conn.cursor()

        try:
            cursor.execute(sql, params)

            if fetch:
                out = cursor.fetchall()
            elif count:
                out = cursor.rowcount
            else:
                out = None

            self.conn.commit()

            return out
        except Exception:
            try:
                self.conn.rollback()
            except Exception:
                pass

            raise
        finally:
            cursor.close()


def open_store(database_url: str | None, pens_dir: str):
    """DATABASE_URL wins; otherwise the file store keeps local dev free of
    any database dependency."""

    if database_url:
        return PostgresStore(database_url)

    return FileStore(pens_dir)


def now_ts() -> float:
    return time.time()