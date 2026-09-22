"""`python -m app` starts the ingest server with settings from the environment."""

from __future__ import annotations

import sys

import uvicorn

from .config import SERVICE_DIR, settings


def main() -> None:
    reload = "--no-reload" not in sys.argv
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=reload,
        reload_dirs=[str(SERVICE_DIR / "app")] if reload else None,
        log_level="info",
    )


if __name__ == "__main__":
    main()
