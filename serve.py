#!/usr/bin/env python3
"""Development entrypoint -- the real server lives in server/app.py.

    ./serve.py [port]        # default 8000

Without DATABASE_URL / GitHub credentials this is the plain local server:
pens in pens/, no login. See README.md for the docker-compose deployment
with Postgres and GitHub login.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
