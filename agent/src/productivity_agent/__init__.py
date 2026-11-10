"""Agent backend for the Personal Productivity Agent desktop app."""

import sys
from importlib.metadata import version

__version__ = version("productivity-agent")


def main() -> None:
    """Serves JSON-RPC over stdin/stdout until stdin closes. `--version` prints the version."""
    if sys.argv[1:] == ["--version"]:
        print(f"productivity-agent {__version__}")
        return

    import asyncio

    from productivity_agent.rpc.stdio import serve_stdio

    asyncio.run(serve_stdio())
