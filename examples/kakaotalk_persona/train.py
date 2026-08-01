from __future__ import annotations

import argparse
import json
import math
import os
import tarfile
import time
from dataclasses import dataclass
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)


DEFAULT_TRAIN_MODEL = "unsloth/Qwen3-30B-A3B-bnb-4bit"
DEFAULT_INFERENCE_MODEL = "Qwen/Qwen3-30B-A3B-GGUF"


@dataclass
class AssistantOnlyCollator:
    tokenizer: object

    def __call__(self, features: list[dict]) -> dict[str, torch.Tensor]:
        width = max(len(item["input_ids"]) for item in features)
        input_ids, attention, labels = [], [], []
        pad_id = self.tokenizer.pad_token_id
        for item in features:
            padding = width - len(item["input_ids"])
            input_ids.append(item["input_ids"] + [pad_id] * padding)
            attention.append(item["attention_mask"] + [0] * padding)
            labels.append(item["labels"] + [-100] * padding)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
        }


class WallClockStop(TrainerCallback):
    def __init__(self, seconds: int) -> None:
        self.seconds = seconds
        self.started = time.monotonic()

    def on_step_end(self, args, state, control, **kwargs):
        if time.monotonic() - self.started >= self.seconds:
            control.should_save = True
            control.should_training_stop = True
        return control


def tokenize_row(row: dict, tokenizer, max_length: int) -> dict:
    messages = row["messages"]
    prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    full = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    full_ids = tokenizer(full, add_special_tokens=False)["input_ids"]
    answer_length = len(full_ids) - len(prompt_ids)
    if answer_length <= 0:
        return {"input_ids": [], "attention_mask": [], "labels": []}
    if len(full_ids) > max_length:
        trim = len(full_ids) - max_length
        full_ids = full_ids[trim:]
        prompt_length = max(0, len(prompt_ids) - trim)
    else:
        prompt_length = len(prompt_ids)
    labels = [-100] * prompt_length + full_ids[prompt_length:]
    return {"input_ids": full_ids, "attention_mask": [1] * len(full_ids), "labels": labels}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("CGR_DATA_DIR", "/workspace/input")))
    parser.add_argument("--data-archive", type=Path, default=Path(os.environ["CGR_DATA_FILE"]) if os.environ.get("CGR_DATA_FILE") else None)
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("CGR_OUTPUT_DIR", "outputs")))
    parser.add_argument("--work", type=Path, default=Path("/workspace/private-work"))
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--train-hours", type=float, default=18.0)
    parser.add_argument("--lora-rank", type=int, default=64)
    parser.add_argument("--train-model", default=DEFAULT_TRAIN_MODEL)
    parser.add_argument("--inference-model", default=DEFAULT_INFERENCE_MODEL)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU가 필요합니다.")
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    torch.cuda.set_device(local_rank)
    args.work.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.data_archive:
        extracted = args.work / "private-input"
        extracted.mkdir(parents=True, exist_ok=True)
        with tarfile.open(args.data_archive, "r:gz") as archive:
            expected = {"train.jsonl", "eval.jsonl", "stats.json"}
            if {member.name for member in archive.getmembers()} != expected:
                raise ValueError("unexpected dataset archive contents")
            for name in expected:
                source = archive.extractfile(name)
                if source is None:
                    raise ValueError(f"missing dataset member: {name}")
                (extracted / name).write_bytes(source.read())
        args.data_dir = extracted
    started = time.time()

    tokenizer = AutoTokenizer.from_pretrained(args.train_model, use_fast=True)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.train_model,
        quantization_config=quantization,
        torch_dtype=torch.bfloat16,
        device_map={"": local_rank},
        attn_implementation="flash_attention_2",
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.config.use_cache = False
    model = get_peft_model(model, LoraConfig(
        task_type="CAUSAL_LM",
        r=args.lora_rank,
        lora_alpha=args.lora_rank * 2,
        lora_dropout=0.05,
        bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    ))

    files = {"train": str(args.data_dir / "train.jsonl"), "eval": str(args.data_dir / "eval.jsonl")}
    dataset = load_dataset("json", data_files=files)
    tokenized = dataset.map(
        lambda row: tokenize_row(row, tokenizer, args.max_length),
        remove_columns=dataset["train"].column_names,
        num_proc=4,
        desc="tokenize private chat windows",
    ).filter(lambda row: len(row["input_ids"]) > 0, num_proc=4)

    training_args = TrainingArguments(
        output_dir=str(args.work / "checkpoints"),
        max_steps=100_000,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=1.0e-4,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        bf16=True,
        tf32=True,
        gradient_checkpointing=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=250,
        save_strategy="steps",
        save_steps=500,
        save_total_limit=2,
        report_to="none",
        optim="paged_adamw_8bit",
        ddp_find_unused_parameters=False,
        dataloader_num_workers=4,
        remove_unused_columns=False,
        seed=903,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized["eval"].select(range(min(2000, len(tokenized["eval"])))),
        data_collator=AssistantOnlyCollator(tokenizer),
        callbacks=[WallClockStop(max(300, int(args.train_hours * 3600)))],
    )
    train_result = trainer.train()
    eval_result = trainer.evaluate()

    if local_rank == 0:
        adapter = args.output / "adapter"
        trainer.model.save_pretrained(adapter, safe_serialization=True)
        tokenizer.save_pretrained(adapter)
        metadata = {
            "training_base_model": args.train_model,
            "local_inference_base_model": args.inference_model,
            "method": "4-bit QLoRA; attention projections only",
            "lora_rank": args.lora_rank,
            "sequence_length": args.max_length,
            "steps": trainer.state.global_step,
            "train_loss": round(float(train_result.training_loss), 6),
            "eval_loss": round(float(eval_result["eval_loss"]), 6),
            "eval_perplexity": round(math.exp(min(20, float(eval_result["eval_loss"]))), 3),
            "seconds": round(time.time() - started, 1),
            "gpus": torch.cuda.device_count(),
            "gpu": torch.cuda.get_device_name(0),
            "privacy": "speaker names and common direct identifiers were redacted locally before upload",
        }
        (args.output / "model-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        print("CGR_MODEL_SUMMARY " + json.dumps(metadata, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
