from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def validate(path: Path) -> dict:
    rows = 0
    errors: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            rows += 1
            try:
                row = json.loads(line)
                messages = row["messages"]
                if [item["role"] for item in messages] != ["system", "user", "assistant"]:
                    raise ValueError("unexpected roles")
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                errors.append({
                    "line": number,
                    "column": getattr(error, "colno", None),
                    "reason": str(error).split(": line", 1)[0],
                    "sha256": hashlib.sha256(line.encode("utf-8")).hexdigest(),
                })
                if len(errors) >= 20:
                    break
    return {"path": path.name, "rows_checked": rows, "valid": not errors, "errors": errors}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    results = [validate(path) for path in args.paths]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(result["valid"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
