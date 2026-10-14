"""Every setting lives in ROOT/.env (see .env.example).

Each entry point calls load_env() first. A variable already in the real
environment wins, so a one-off override on the command line still works.
Helpers spawned by the Electron app inherit what it loaded from the same file.
FRIDAY_ENV_FILE points at another file, or at none when empty (the tests use
that so the owner's settings never leak into them).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path | None = None) -> None:
    if path is None:
        setting = os.environ.get("FRIDAY_ENV_FILE")
        if setting == "":
            return
        path = Path(setting) if setting else ENV_FILE
    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        sys.stderr.write(f"settings in {path} ignored: {exc}\n")
        return
    load_dotenv(path, override=False)
