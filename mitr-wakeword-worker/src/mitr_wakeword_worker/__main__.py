from __future__ import annotations

import asyncio
import logging

from .config import WorkerConfig
from .worker import WakewordWorker


async def _main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    worker = WakewordWorker(WorkerConfig.from_env())
    try:
        await worker.run()
    finally:
        await worker.close()


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
