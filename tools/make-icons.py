"""Draws the app icon (a plain vector-style reticle) as PNGs, standard library only."""
import math, struct, sys, zlib


def png(size):
    c = (size - 1) / 2
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            dx, dy = (x - c) / size, (y - c) / size
            r = math.hypot(dx, dy)
            ring = abs(r - 0.30)
            cross = min(abs(dx), abs(dy)) if 0.10 < max(abs(dx), abs(dy)) < 0.40 else 1
            d = min(ring, cross)
            core = max(0.0, 1 - d / 0.012)
            glow = max(0.0, 1 - d / 0.06) ** 2 * 0.45
            v = min(1.0, core + glow)
            rows += bytes((int(40 * v), int(255 * v), int(110 * v)))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))


out = sys.argv[1]
for size in (180, 512):
    with open(f'{out}/icon-{size}.png', 'wb') as f:
        f.write(png(size))
