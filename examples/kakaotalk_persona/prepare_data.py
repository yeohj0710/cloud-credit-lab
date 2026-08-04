from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import tarfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


MESSAGE_RE = re.compile(
    r"^(?P<year>\d{4})\.\s*(?P<month>\d{1,2})\.\s*(?P<day>\d{1,2})\.\s*"
    r"(?:(?P<ampm>오전|오후)\s*)?(?P<hour>\d{1,2}):(?P<minute>\d{2}),\s*"
    r"(?P<speaker>.+?)\s*:\s?(?P<body>.*)$"
)
URL_RE = re.compile(r"(?i)(?:https?://|www\.)[^\s<>\"']+")
EMAIL_RE = re.compile(r"(?i)[\w.+-]+@[\w.-]+\.[a-z]{2,}")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?82[- .]?)?(?:0?1[016789]|0\d{1,2})[- .]?\d{3,4}[- .]?\d{4}(?!\d)")
RRN_RE = re.compile(r"(?<!\d)\d{6}\s*[- ]?\s*[1-4]\d{6}(?!\d)")
IP_RE = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
ACCOUNT_RE = re.compile(r"(?<!\d)\d{2,6}(?:[- ]\d{2,6}){2,5}(?!\d)")
LONG_NUMBER_RE = re.compile(r"(?<!\d)\d{6,}(?!\d)")
WINDOWS_PATH_RE = re.compile(r"(?i)(?:[a-z]:\\|\\\\)[^\s<>|\"']+")
HANDLE_RE = re.compile(r"(?<!\w)@[A-Za-z0-9_.-]{2,}")


@dataclass
class RawMessage:
    timestamp: datetime
    speaker: str
    body: str


def parse_timestamp(match: re.Match[str]) -> datetime:
    hour = int(match.group("hour"))
    ampm = match.group("ampm")
    if ampm == "오전" and hour == 12:
        hour = 0
    elif ampm == "오후" and hour < 12:
        hour += 12
    return datetime(
        int(match.group("year")), int(match.group("month")), int(match.group("day")), hour, int(match.group("minute"))
    )


def parse_export(path: Path) -> list[RawMessage]:
    text = path.read_text(encoding="utf-8-sig")
    messages: list[RawMessage] = []
    for line in text.splitlines():
        match = MESSAGE_RE.match(line)
        if match:
            messages.append(RawMessage(parse_timestamp(match), match.group("speaker").strip(), match.group("body").strip()))
        elif messages and line.strip():
            messages[-1].body += "\n" + line.strip()
    return messages


def alias_for(kind: str, value: str, salt: bytes) -> str:
    digest = hmac.new(salt, f"{kind}\0{value}".encode("utf-8"), hashlib.sha256).hexdigest()[:10].upper()
    return f"{kind}_{digest}"


def redact(text: str, known_names: dict[str, str]) -> tuple[str, Counter[str]]:
    counts: Counter[str] = Counter()

    def replace(pattern: re.Pattern[str], label: str, value: str) -> str:
        def sub(_: re.Match[str]) -> str:
            counts[label] += 1
            return f"<{label}>"

        return pattern.sub(sub, value)

    value = text
    for name in sorted(known_names, key=len, reverse=True):
        if len(name) >= 2 and name in value:
            occurrences = value.count(name)
            value = value.replace(name, known_names[name])
            counts["PARTICIPANT_NAME"] += occurrences
    for pattern, label in (
        (WINDOWS_PATH_RE, "PATH"), (URL_RE, "URL"), (EMAIL_RE, "EMAIL"), (RRN_RE, "RRN"),
        (PHONE_RE, "PHONE"), (IP_RE, "IP"), (ACCOUNT_RE, "ACCOUNT"), (HANDLE_RE, "HANDLE"),
        (LONG_NUMBER_RE, "LONG_NUMBER"),
    ):
        value = replace(pattern, label, value)
    return value.strip(), counts


def collapse_turns(messages: Iterable[RawMessage], aliases: dict[str, str]) -> list[RawMessage]:
    turns: list[RawMessage] = []
    for message in messages:
        speaker = aliases[message.speaker]
        if turns and turns[-1].speaker == speaker and (message.timestamp - turns[-1].timestamp).total_seconds() <= 120:
            combined = turns[-1].body + "\n" + message.body
            if len(combined) <= 1200:
                turns[-1].body = combined
                turns[-1].timestamp = message.timestamp
                continue
        turns.append(RawMessage(message.timestamp, speaker, message.body))
    return turns


def write_jsonl(path: Path, rows: Iterable[dict]) -> int:
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            safe_row = {
                **row,
                "messages": [
                    {**message, "content": redact(message["content"], {})[0]}
                    for message in row["messages"]
                ],
            }
            handle.write(json.dumps(safe_row, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return count


def build_examples(room: str, turns: list[RawMessage], cutoff: datetime, context_turns: int) -> tuple[list[dict], list[dict]]:
    train: list[dict] = []
    eval_rows: list[dict] = []
    system = (
        "비공개 카카오톡 대화의 말투를 재현한다. 참가자는 가명으로만 표시한다. "
        "문맥에 없는 개인정보나 실제 인물의 사적 사실을 추측하거나 공개하지 않는다."
    )
    for index in range(3, len(turns)):
        target = turns[index]
        if not target.body or len(target.body) > 1200:
            continue
        context = turns[max(0, index - context_turns):index]
        transcript = "\n".join(f"{item.speaker}: {item.body}" for item in context)
        user = f"<CHAT room=\"{room}\">\n{transcript}\n</CHAT>\n{target.speaker}로 다음 답장만 작성해."
        row = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
                {"role": "assistant", "content": target.body},
            ],
            "room": room,
            "target": target.speaker,
        }
        (eval_rows if target.timestamp >= cutoff else train).append(row)
    return train, eval_rows


def consent_is_valid(path: Path) -> bool:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return bool(value.get("all_participants_consented")) and value.get("scope") == "naver-cloud-private-persona-training"


def prepare(input_dir: Path, output_dir: Path, consent_manifest: Path | None, inventory_only: bool, context_turns: int) -> dict:
    files = sorted(input_dir.rglob("*.txt"))
    if not files:
        raise ValueError("카카오톡 TXT 파일을 찾지 못했습니다.")
    parsed = [(path, parse_export(path)) for path in files]
    speakers = sorted({message.speaker for _, messages in parsed for message in messages})
    inventory = {
        "files": len(files),
        "messages": sum(len(messages) for _, messages in parsed),
        "participants": len(speakers),
        "bytes": sum(path.stat().st_size for path in files),
    }
    if inventory_only:
        return inventory
    if consent_manifest is None or not consent_is_valid(consent_manifest):
        raise PermissionError("유효한 참여자 동의 매니페스트가 필요합니다.")

    output_dir.mkdir(parents=True, exist_ok=True)
    salt_path = output_dir / "pseudonym-salt.local"
    if salt_path.exists():
        salt = bytes.fromhex(salt_path.read_text(encoding="ascii").strip())
    else:
        salt = secrets.token_bytes(32)
        salt_path.write_text(salt.hex(), encoding="ascii")
    aliases = {speaker: alias_for("P", speaker, salt) for speaker in speakers}
    identity = {
        "warning": "로컬 전용 파일입니다. 클라우드에 올리거나 커밋하지 마세요.",
        "participants": [{"alias": aliases[name], "local_name": name} for name in speakers],
    }
    (output_dir / "identity-map.local.json").write_text(json.dumps(identity, ensure_ascii=False, indent=2), encoding="utf-8")

    train_rows: list[dict] = []
    eval_rows: list[dict] = []
    redactions: Counter[str] = Counter()
    room_counts: dict[str, int] = {}
    participant_counts: Counter[str] = Counter()
    for path, raw_messages in parsed:
        room = alias_for("ROOM", str(path.relative_to(input_dir)), salt)
        sanitized: list[RawMessage] = []
        for message in raw_messages:
            body, counts = redact(message.body, aliases)
            redactions.update(counts)
            if body:
                sanitized.append(RawMessage(message.timestamp, message.speaker, body))
        turns = collapse_turns(sanitized, aliases)
        if len(turns) < 10:
            continue
        for turn in turns:
            participant_counts[turn.speaker] += 1
        cutoff = turns[max(1, int(len(turns) * 0.9))].timestamp
        room_train, room_eval = build_examples(room, turns, cutoff, context_turns)
        train_rows.extend(room_train)
        eval_rows.extend(room_eval)
        room_counts[room] = len(turns)

    train_count = write_jsonl(output_dir / "train.jsonl", train_rows)
    eval_count = write_jsonl(output_dir / "eval.jsonl", eval_rows)
    stats = {
        **inventory,
        "train_examples": train_count,
        "eval_examples": eval_count,
        "rooms": len(room_counts),
        "room_turn_counts": room_counts,
        "participant_turn_counts": dict(participant_counts),
        "redactions": dict(redactions),
        "time_split": "latest 10% of each room reserved for evaluation",
        "raw_names_in_training_files": False,
    }
    (output_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    with tarfile.open(output_dir / "cloud-dataset.tar.gz", "w:gz") as archive:
        for name in ("train.jsonl", "eval.jsonl", "stats.json"):
            archive.add(output_dir / name, arcname=name, recursive=False)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="카카오톡 내보내기 파일을 로컬에서 가명처리합니다.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--consent-manifest", type=Path)
    parser.add_argument("--inventory-only", action="store_true")
    parser.add_argument("--context-turns", type=int, default=16)
    args = parser.parse_args()
    if not args.inventory_only and args.output_dir is None:
        parser.error("--output-dir is required unless --inventory-only is used")
    result = prepare(args.input_dir, args.output_dir or Path("."), args.consent_manifest, args.inventory_only, args.context_turns)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
