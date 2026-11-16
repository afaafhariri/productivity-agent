import asyncio
import contextlib
from datetime import UTC, datetime

import keyring
from keyring.errors import PasswordDeleteError

KEYRING_SERVICE = "productivity-agent"


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class KeyringSecretStore:
    """Secrets in the OS credential store (macOS Keychain, Windows Credential Manager, Secret
    Service on Linux) via `keyring`.

    Calls run in a thread because a backend may block, e.g. on a macOS Keychain access prompt.
    Set PYTHON_KEYRING_BACKEND (a keyring feature) to use another backend, e.g. in tests.
    """

    def __init__(self, service: str = KEYRING_SERVICE) -> None:
        self._service = service

    async def get(self, key: str) -> str | None:
        return await asyncio.to_thread(keyring.get_password, self._service, key)

    async def set(self, key: str, value: str) -> None:
        await asyncio.to_thread(keyring.set_password, self._service, key, value)

    async def delete(self, key: str) -> None:
        def delete() -> None:
            with contextlib.suppress(PasswordDeleteError):  # Already absent.
                keyring.delete_password(self._service, key)

        await asyncio.to_thread(delete)


class InMemorySecretStore:
    """Nothing is persisted. For tests and experiments."""

    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self._values.get(key)

    async def set(self, key: str, value: str) -> None:
        self._values[key] = value

    async def delete(self, key: str) -> None:
        self._values.pop(key, None)
