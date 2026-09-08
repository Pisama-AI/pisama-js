"""Canonical gzip encoding for npm tarballs; never modifies the tar stream.

Node bundles a modified zlib whose deflate bytes differ from standard zlib.
Release digests bind the complete gzip file, not just unpacked members. Use
standard zlib level 6, mtime=0, no filename, and fixed OS byte 19 matching the
reviewed archives (metadata, not a target-platform requirement). The existing
independent expected-SHA check remains authoritative if a compressor changes.
"""

import gzip
import io
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import zlib


MAX_BYTES = 64 * 1024 * 1024
HEADER = bytes.fromhex("1f8b0800000000000013")


def canonicalize(path: Path) -> None:
    if path.suffix != ".tgz":
        raise ValueError("Expected a .tgz artifact")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
            raise ValueError("Expected a bounded regular artifact")
        original = source.read(MAX_BYTES + 1)
    if len(original) > MAX_BYTES:
        raise ValueError("Compressed artifact exceeds size limit")
    with gzip.GzipFile(fileobj=io.BytesIO(original)) as source:
        tar_bytes = source.read(MAX_BYTES + 1)
    if not tar_bytes or len(tar_bytes) > MAX_BYTES:
        raise ValueError("Expanded artifact is empty or exceeds size limit")
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    encoded = (
        HEADER
        + compressor.compress(tar_bytes)
        + compressor.flush()
        + struct.pack("<II", zlib.crc32(tar_bytes), len(tar_bytes))
    )
    if gzip.decompress(encoded) != tar_bytes:
        raise ValueError("Canonical encoding changed artifact content")
    if encoded == original:
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".canonical-", delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: canonicalize-npm-archive.py ARTIFACT.tgz [...]")
    for argument in sys.argv[1:]:
        canonicalize(Path(argument))
