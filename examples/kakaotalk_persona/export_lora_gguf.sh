#!/usr/bin/env bash
set -Eeuo pipefail

OUTPUT="${CGR_OUTPUT_DIR:-outputs}"
BASE_MODEL_ID="${LORA_BASE_MODEL_ID:-Qwen/Qwen3-30B-A3B}"
OUTPUT_NAME="${LORA_OUTPUT_NAME:-kakaotalk-persona-lora-f16.gguf}"
git clone --depth 1 https://github.com/ggml-org/llama.cpp /workspace/llama.cpp
python3 -m pip install -r /workspace/llama.cpp/requirements.txt
python3 /workspace/llama.cpp/convert_lora_to_gguf.py \
  --base-model-id "$BASE_MODEL_ID" \
  --outfile "$OUTPUT/$OUTPUT_NAME" \
  --outtype f16 \
  "$OUTPUT/adapter"
sha256sum "$OUTPUT/$OUTPUT_NAME" > "$OUTPUT/SHA256SUMS.txt"
