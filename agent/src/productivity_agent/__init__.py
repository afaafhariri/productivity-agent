"""Agent backend for the Personal Productivity Agent desktop app."""

from importlib.metadata import version

__version__ = version("productivity-agent")


def main() -> None:
    """Entry point. The stdio JSON-RPC server replaces this in a later PR."""
    print(f"productivity-agent {__version__}")
