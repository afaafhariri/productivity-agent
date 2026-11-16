import asyncio
from collections.abc import Iterator

import keyring
import pytest
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from productivity_agent.host.adapters import KeyringSecretStore


class MemoryKeyring(KeyringBackend):
    """In-process keyring backend: tests never touch the real OS keychain."""

    priority = 1

    def __init__(self) -> None:
        super().__init__()  # type: ignore[no-untyped-call]  # keyring is untyped here.
        self.items: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.items.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.items[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if self.items.pop((service, username), None) is None:
            raise PasswordDeleteError(username)


@pytest.fixture
def memory_keyring() -> Iterator[MemoryKeyring]:
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    try:
        yield backend
    finally:
        keyring.set_keyring(previous)


def test_keyring_store_round_trip(memory_keyring: MemoryKeyring) -> None:
    store = KeyringSecretStore(service="ppa-test")

    async def scenario() -> None:
        assert await store.get("k") is None
        await store.set("k", "secret")
        assert memory_keyring.items == {("ppa-test", "k"): "secret"}
        assert await store.get("k") == "secret"
        await store.delete("k")
        await store.delete("k")  # Deleting a missing secret is not an error.
        assert await store.get("k") is None

    asyncio.run(scenario())
