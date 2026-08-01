from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import tarfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "examples" / "kakaotalk_persona" / "prepare_data.py"
SPEC = importlib.util.spec_from_file_location("kakaotalk_prepare", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class KakaoTalkPersonaTest(unittest.TestCase):
    def test_write_jsonl_keeps_json_valid_when_redacting_url(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "rows.jsonl"
            row = {
                "messages": [
                    {"role": "system", "content": "규칙"},
                    {"role": "user", "content": "https://example.com/path\" 뒤 문장"},
                    {"role": "assistant", "content": "답장"},
                ],
                "room": "ROOM_TEST",
                "target": "P_TEST",
            }

            MODULE.write_jsonl(output, [row])

            parsed = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(parsed["messages"][1]["content"], "<URL>\" 뒤 문장")

    def test_parse_redact_time_split_and_consent_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            lines = ["저장한 날짜 : 2026-07-31"]
            for index in range(30):
                speaker = "민수" if index % 2 == 0 else "지연"
                body = f"메시지 {index} test{index}@example.com 010-1234-5678 https://example.com/{index}"
                lines.append(f"2026. 7. {1 + index // 10}. {10 + index % 10}:00, {speaker} : {body}")
            (source / "room.txt").write_text("\n".join(lines), encoding="utf-8-sig")

            inventory = MODULE.prepare(source, output, None, True, 8)
            self.assertEqual(inventory["messages"], 30)
            with self.assertRaises(PermissionError):
                MODULE.prepare(source, output, None, False, 8)

            consent = root / "consent.json"
            consent.write_text(json.dumps({
                "all_participants_consented": True,
                "scope": "naver-cloud-private-persona-training",
            }), encoding="utf-8")
            stats = MODULE.prepare(source, output, consent, False, 8)
            self.assertGreater(stats["train_examples"], 0)
            self.assertGreater(stats["eval_examples"], 0)
            training = (output / "train.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("민수", training)
            self.assertNotIn("지연", training)
            self.assertNotIn("test0@example.com", training)
            self.assertNotIn("010-1234-5678", training)
            self.assertNotIn("https://example.com", training)
            self.assertIn("<EMAIL>", training)
            self.assertTrue((output / "identity-map.local.json").exists())
            with tarfile.open(output / "cloud-dataset.tar.gz", "r:gz") as archive:
                self.assertEqual(sorted(archive.getnames()), ["eval.jsonl", "stats.json", "train.jsonl"])


if __name__ == "__main__":
    unittest.main()
