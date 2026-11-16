"""Runs the RPC server over this process's stdin/stdout.

stdout carries protocol messages only. `sys.stdout` is pointed at stderr so a stray
print() can never corrupt the stream. Blocking reads/writes run in threads, which works
the same on macOS, Linux and Windows (asyncio pipes don't support Windows stdin).
"""

import asyncio
import logging
import os
import sys
from typing import BinaryIO

from productivity_agent.core.integrations import register_stub_tools
from productivity_agent.core.llm import LlmConfig, create_model
from productivity_agent.core.tools import ToolRegistry
from productivity_agent.host.adapters import InMemorySecretStore, SystemClock
from productivity_agent.rpc.server import RpcServer


class StdinReader:
    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream

    async def read_line(self) -> bytes | None:
        line = await asyncio.to_thread(self._stream.readline)
        return line.rstrip(b"\r\n") if line else None


class StdoutWriter:
    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream

    def _write(self, data: bytes) -> None:
        self._stream.write(data)
        self._stream.flush()

    async def write_line(self, line: str) -> None:
        await asyncio.to_thread(self._write, line.encode() + b"\n")


def configure_logging() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def serve_stdio() -> None:
    protocol_out = sys.stdout.buffer
    sys.stdout = sys.stderr
    configure_logging()

    logger = logging.getLogger(__name__)
    config = LlmConfig.from_env()
    logger.info("starting backend", extra={"provider": config.provider})
    try:
        model = create_model(config)
    except ValueError as error:
        logger.error("invalid LLM configuration: %s", error)
        raise SystemExit(2) from error
    registry = ToolRegistry()
    register_stub_tools(registry)
    server = RpcServer(
        writer=StdoutWriter(protocol_out),
        model=model,
        llm_config=config,
        registry=registry,
        secrets=InMemorySecretStore(),
        clock=SystemClock(),
    )
    await server.serve(StdinReader(sys.stdin.buffer))
