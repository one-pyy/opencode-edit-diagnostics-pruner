"""Full SQLite online backup, including committed WAL contents."""

import os
from pathlib import Path
import sqlite3
import sys
import time

source_path, target_path = map(Path, sys.argv[1:3])
show_progress = '--progress' in sys.argv[3:]
last_update = 0.0


def progress(status, remaining, total):
    global last_update
    now = time.monotonic()
    if show_progress and (remaining == 0 or now - last_update >= 1):
        last_update = now
        copied = total - remaining
        percent = 100 * copied / total if total else 100
        prefix = '\r' if sys.stderr.isatty() else ''
        ending = '\n' if remaining == 0 or not sys.stderr.isatty() else ''
        print(f'{prefix}Backup {copied}/{total} pages {percent:.1f}%', end=ending, file=sys.stderr, flush=True)
fd = os.open(target_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
try:
    with sqlite3.connect(source_path.resolve().as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(target_path) as target:
            source.backup(target, pages=1024, sleep=0.05, progress=progress)
            if show_progress:
                print('Validating backup (quick_check)...', file=sys.stderr, flush=True)
            if target.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise RuntimeError("Backup quick_check failed")
    os.chmod(target_path, 0o600)
except BaseException:
    target_path.unlink(missing_ok=True)
    raise
