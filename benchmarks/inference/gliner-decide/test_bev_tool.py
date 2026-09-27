import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("bev_tool", Path(__file__).with_name("bev_tool.py"))
bev_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bev_tool)


class BevToolSplitTest(unittest.TestCase):
    def test_request_group_does_not_cross_splits(self):
        def row(request, label):
            import json
            return {"domain": "Tool and workflow decisions",
                    "state": json.dumps({"request": request, "available_tool": {"name": "lookup"}}),
                    "questions_json": json.dumps({"should_call_available_tool":
                        {"type": "noul", "label": label}})}

        train = [row(f"Please check item number {i} for me.", i % 2 == 0) for i in range(100)]
        train.append(row("Please check item number 0 for me.", False))
        test = [row("Please check item number 0 for me.", True),
                row("Please check item number 1 for me.", False)]
        splits = bev_tool.choose_cases(train, test)
        self.assertTrue(splits["train"])
        self.assertTrue(splits["validation"])
        self.assertEqual(len(splits["test"]), 2)
        groups = [{x["group"] for x in splits[s]} for s in ("train", "validation", "test")]
        self.assertFalse(groups[0] & groups[1])
        self.assertFalse(groups[0] & groups[2])
        self.assertFalse(groups[1] & groups[2])
        self.assertEqual(len(sum(splits.values(), [])), 100)

    def test_training_label_is_not_in_input(self):
        case = bev_tool.training_case({"text": "request and available tool", "label": "skip"})
        self.assertEqual(case["input"], "request and available tool")
        self.assertEqual(case["output"]["classifications"][0]["true_label"], ["skip"])


if __name__ == "__main__":
    unittest.main()
