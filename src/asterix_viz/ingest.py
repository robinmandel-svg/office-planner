from __future__ import annotations

import asyncio
import socket
from datetime import datetime, timezone

from .models import RawPacket
from .store import PacketStore


class UdpIngestService:
    def __init__(
        self,
        store: PacketStore,
        host: str = "0.0.0.0",
        port: int = 30062,
        multicast_group: str | None = None,
        multicast_interface: str = "0.0.0.0",
    ) -> None:
        self.store = store
        self.host = host
        self.port = port
        self.multicast_group = multicast_group
        self.multicast_interface = multicast_interface
        self._sock: socket.socket | None = None
        self._task: asyncio.Task[None] | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, self.port))

        if self.multicast_group:
            mreq = socket.inet_aton(self.multicast_group) + socket.inet_aton(self.multicast_interface)
            self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)

        self._sock.setblocking(False)
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        if self._sock:
            self._sock.close()
            self._sock = None

    async def _loop(self) -> None:
        assert self._sock is not None
        loop = asyncio.get_running_loop()
        while self._running:
            data, addr = await loop.sock_recvfrom(self._sock, 65535)
            source = f"{addr[0]}:{addr[1]}"
            raw = RawPacket(payload=data, source=source, received_at=datetime.now(timezone.utc))
            self.store.ingest(raw)
