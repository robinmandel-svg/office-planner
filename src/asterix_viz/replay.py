from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .models import RawPacket
from .store import PacketStore


@dataclass(slots=True)
class ReplayFrame:
    delay_ms: int
    payload: bytes
    source: str


class ReplayService:
    def __init__(self, store: PacketStore) -> None:
        self.store = store
        self.frames: list[ReplayFrame] = []
        self.index = 0
        self.loop = False
        self.speed = 1.0
        self.running = False
        self._task: asyncio.Task[None] | None = None

    def load_frames(self, frames: list[ReplayFrame]) -> int:
        self.stop_sync()
        self.frames = frames
        self.index = 0
        return len(frames)

    def load_from_hex_lines(self, path: Path) -> int:
        frames: list[ReplayFrame] = []
        for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split(maxsplit=1)
            if len(parts) == 1:
                delay_ms = 200
                hex_bytes = parts[0]
            else:
                try:
                    delay_ms = int(parts[0])
                    hex_bytes = parts[1]
                except ValueError:
                    delay_ms = 200
                    hex_bytes = line

            hex_clean = "".join(hex_bytes.split())
            if len(hex_clean) % 2 != 0:
                raise ValueError(f"Invalid hex length at line {lineno}.")

            try:
                payload = bytes.fromhex(hex_clean)
            except ValueError as exc:
                raise ValueError(f"Invalid hex at line {lineno}: {exc}") from exc

            frames.append(ReplayFrame(delay_ms=max(0, delay_ms), payload=payload, source=f"replay:{path.name}:{lineno}"))

        return self.load_frames(frames)

    async def start(self, speed: float = 1.0, loop: bool = False) -> None:
        if self.running:
            return
        if not self.frames:
            raise ValueError("No replay frames loaded.")

        self.speed = max(0.1, float(speed))
        self.loop = loop
        self.running = True
        self._task = asyncio.create_task(self._run())

    def step(self, count: int = 1) -> int:
        if self.running:
            raise ValueError("Cannot step while replay is running. Pause first.")
        if not self.frames:
            raise ValueError("No replay frames loaded.")

        ingested = 0
        for _ in range(max(1, int(count))):
            if self.index >= len(self.frames):
                if self.loop:
                    self.index = 0
                else:
                    break

            frame = self.frames[self.index]
            self.index += 1
            self.store.ingest(
                RawPacket(payload=frame.payload, source=frame.source, received_at=datetime.now(timezone.utc))
            )
            ingested += 1

        return ingested

    def reset(self) -> None:
        self.index = 0

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def stop_sync(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self.running = False

    async def _run(self) -> None:
        while self.running:
            if self.index >= len(self.frames):
                if self.loop:
                    self.index = 0
                else:
                    self.running = False
                    break

            frame = self.frames[self.index]
            self.index += 1
            self.store.ingest(
                RawPacket(payload=frame.payload, source=frame.source, received_at=datetime.now(timezone.utc))
            )

            wait_s = (frame.delay_ms / 1000.0) / self.speed
            if wait_s > 0:
                await asyncio.sleep(wait_s)

    def status(self) -> dict[str, object]:
        return {
            "loaded_frames": len(self.frames),
            "index": self.index,
            "remaining_frames": max(0, len(self.frames) - self.index),
            "running": self.running,
            "loop": self.loop,
            "speed": self.speed,
        }
