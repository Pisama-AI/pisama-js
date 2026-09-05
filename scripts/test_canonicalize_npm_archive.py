"""Real-file canonical archive regressions, without mocks or registry I/O."""

import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "canonical_archive", Path(__file__).with_name("canonicalize-npm-archive.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def tar_stream(content=b"reviewed package content"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        info = tarfile.TarInfo("package/index.js")
        info.size = len(content)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


class CanonicalArchiveTests(unittest.TestCase):
    def test_preserves_exact_tar_stream_mode_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "package.tgz"
            raw = tar_stream()
            artifact.write_bytes(gzip.compress(raw, compresslevel=1, mtime=123))
            artifact.chmod(0o640)
            module.canonicalize(artifact)
            canonical = artifact.read_bytes()
            self.assertEqual(gzip.decompress(canonical), raw)
            self.assertEqual(canonical[:10], module.HEADER)
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o640)
            module.canonicalize(artifact)
            self.assertEqual(artifact.read_bytes(), canonical)
            self.assertEqual(list(Path(directory).iterdir()), [artifact])

    def test_content_tampering_still_changes_the_full_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            hashes = []
            for name, content in [("reviewed", b"reviewed"), ("tampered", b"tampered")]:
                artifact = Path(directory) / (name + ".tgz")
                artifact.write_bytes(gzip.compress(tar_stream(content)))
                module.canonicalize(artifact)
                hashes.append(hashlib.sha256(artifact.read_bytes()).digest())
            self.assertNotEqual(*hashes)

    def test_invalid_or_truncated_gzip_is_not_overwritten(self):
        for data in [b"not gzip", gzip.compress(tar_stream())[:-4]]:
            with self.subTest(data_length=len(data)), tempfile.TemporaryDirectory() as directory:
                artifact = Path(directory) / "package.tgz"
                artifact.write_bytes(data)
                with self.assertRaises((OSError, EOFError)):
                    module.canonicalize(artifact)
                self.assertEqual(artifact.read_bytes(), data)

    def test_symlink_is_rejected_without_changing_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.tgz"
            original = gzip.compress(tar_stream(), mtime=123)
            target.write_bytes(original)
            link = Path(directory) / "link.tgz"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                module.canonicalize(link)
            self.assertEqual(target.read_bytes(), original)
            self.assertTrue(link.is_symlink())

    def test_wrong_suffix_is_rejected(self):
        with self.assertRaises(ValueError):
            module.canonicalize(Path("package.tar"))

    def test_expansion_limit_rejects_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "package.tgz"
            original = gzip.compress(b"x" * (module.MAX_BYTES + 1))
            artifact.write_bytes(original)
            with self.assertRaises(ValueError):
                module.canonicalize(artifact)
            self.assertEqual(artifact.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
