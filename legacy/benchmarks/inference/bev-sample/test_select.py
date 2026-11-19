import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).with_name("select.py")
spec = importlib.util.spec_from_file_location("bev_sample_select", MODULE)
select_sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(select_sample)


class DatasetDigestTest(unittest.TestCase):
    def test_matching_digest_is_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.parquet"
            source.write_bytes(b"pinned dataset")
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(select_sample.require_digest(source, expected, "test"), expected)

    def test_mismatched_digest_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.parquet"
            source.write_bytes(b"altered dataset")
            with self.assertRaisesRegex(ValueError, "BEV train source digest mismatch"):
                select_sample.require_digest(source, "0" * 64, "train")


if __name__ == "__main__":
    unittest.main()
