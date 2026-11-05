"""Minimal PNG writer used by the vision capability probe.

No third-party imaging library is required: the probe image is a tiny RGB
bitmap, so the PNG container is written directly with zlib.
"""

from __future__ import annotations

import struct
import zlib


def make_rgb_png(width: int, height: int, pixels: list[tuple[int, int, int]]) -> bytes:
    """Encode ``pixels`` (row-major, len == width*height) as an 8-bit RGB PNG."""
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")
    if len(pixels) != width * height:
        raise ValueError("pixel count does not match width*height")

    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type: none
        for x in range(width):
            r, g, b = pixels[y * width + x]
            rows.extend((r & 0xFF, g & 0xFF, b & 0xFF))

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def make_split_probe_png(size: int = 64) -> bytes:
    """A square split vertically: left half pure red, right half pure blue."""
    mid = size // 2
    pixels = [
        (220, 30, 30) if x < mid else (30, 40, 220)
        for _y in range(size)
        for x in range(size)
    ]
    return make_rgb_png(size, size, pixels)
