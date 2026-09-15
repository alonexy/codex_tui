"""Generate opaque Home Screen PNG icons using only the Python standard library."""
import math
from pathlib import Path
import struct
import zlib


def distance(x, y, line):
    ax, ay, bx, by = line
    t = max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
    return math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


def generate(size, path):
    lines = [(29, 35, 43, 49), (43, 49, 29, 63), (53, 64, 72, 64)]
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            d = min(distance((x + .5) * 100 / size, (y + .5) * 100 / size, line) for line in lines)
            alpha = max(0, min(1, (3 - d) * size / 100 + .5))
            color = round(24 + (240 - 24) * alpha)
            raw.extend((color, color, color))
    header = struct.pack('!2I5B', size, size, 8, 2, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    public = Path(__file__).resolve().parent.parent / 'public'
    generate(180, public / 'apple-touch-icon.png')
    generate(512, public / 'icon-512.png')
