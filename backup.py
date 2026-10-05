"""Full SQLite online backup, including committed WAL contents."""

import os
from pathlib import Path
import sqlite3
import sys

source_path, target_path = map(Path, sys.argv[1:])
fd = os.open(target_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
try:
    with sqlite3.connect(source_path.resolve().as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(target_path) as target:
            source.backup(target, pages=1024, sleep=0.05)
            if target.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise RuntimeError("Backup quick_check failed")
    os.chmod(target_path, 0o600)
except BaseException:
    target_path.unlink(missing_ok=True)
    raise
