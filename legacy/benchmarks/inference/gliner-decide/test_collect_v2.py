import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("collect_v2", HERE / "collect_v2.py")
collect_v2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collect_v2)


class CollectV2Test(unittest.TestCase):
    def test_rejects_reused_group_id(self):
        with self.assertRaisesRegex(ValueError, "reused group"):
            collect_v2.check_independence(
                [{"group": "same", "text": "fresh text"}],
                [{"group": "same", "text": "older text"}],
            )

    def test_rejects_exact_rendered_input(self):
        with self.assertRaisesRegex(ValueError, "reused text"):
            collect_v2.check_independence(
                [{"group": "new", "text": "Same text with whitespace "}],
                [{"group": "old", "text": "same text with whitespace"}],
            )

    def test_distinct_groups_and_inputs(self):
        collect_v2.check_independence(
            [{"group": "new", "text": "A new case."}],
            [{"group": "old", "text": "An old case."}],
        )


if __name__ == "__main__":
    unittest.main()
