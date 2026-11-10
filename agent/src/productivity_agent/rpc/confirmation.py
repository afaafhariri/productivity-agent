import asyncio
from collections.abc import Awaitable, Callable

from productivity_agent.core.ports import ConfirmationDecision, ConfirmationRequest
from productivity_agent.rpc import protocol


class RpcConfirmation:
    """Confirmation port for one run: asks the app and waits for `confirmation.respond`."""

    def __init__(self, send_event: Callable[[protocol.RunEvent], Awaitable[None]]) -> None:
        self._send_event = send_event
        self._pending: dict[str, asyncio.Future[ConfirmationDecision]] = {}

    async def request(self, request: ConfirmationRequest) -> ConfirmationDecision:
        future: asyncio.Future[ConfirmationDecision] = asyncio.get_running_loop().create_future()
        self._pending[request.tool_call_id] = future
        try:
            await self._send_event(
                protocol.ConfirmationRequest(
                    tool_call_id=request.tool_call_id,
                    tool_name=request.tool_name,
                    description=request.description,
                    input=request.input,
                )
            )
            return await future
        finally:
            self._pending.pop(request.tool_call_id, None)

    def respond(self, tool_call_id: str, decision: ConfirmationDecision) -> bool:
        """Resolves a pending request. Returns False if nothing is waiting for that call."""
        future = self._pending.get(tool_call_id)
        if future is None or future.done():
            return False
        future.set_result(decision)
        return True
