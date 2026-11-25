#!/usr/bin/env bash
# Publish ATC-ASR (our parakeet-110m-atc fine-tune, the int8 ONNX files the browser runs) to Hugging Face,
# whose CDN then serves the on-device download instead of this server.
#   HF_TOKEN=hf_... scripts/publish-stt-model.sh          (a token with write access)
# Then build with NEXT_PUBLIC_STT_MODEL_BASE=https://huggingface.co/$REPO/resolve/main/ (printed at the end).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=${REPO:-srinath-exe/skycontrol-atc-asr-110m}
SRC=public/models/stt/parakeet-110m-atc-v1
[ -n "${HF_TOKEN:-}" ] || { echo "set HF_TOKEN (write access)"; exit 1; }
python3 -c "import huggingface_hub" 2>/dev/null || pip install -q huggingface_hub
cat > "$SRC/README.md" <<'MD'
---
license: cc-by-4.0
language: en
tags: [speech-recognition, asr, air-traffic-control, onnx, transducer, browser]
base_model: nvidia/parakeet-tdt_ctc-110m
---
# ATC-ASR 110M

The speech model of [OpenATC](https://openatc.aeon-labs.site): NVIDIA Parakeet TDT-CTC 110M fine-tuned on air
traffic control speech (callsigns, phonetic letters, grouped numbers, ATC phraseology). int8 ONNX (encoder, decoder,
joiner; sherpa-onnx layout) so it runs in the browser on ONNX Runtime Web, offline.

- 16 kHz mono; 80-bin log-mel (NeMo); greedy TDT decoding
- Files: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`

Based on nvidia/parakeet-tdt_ctc-110m (CC-BY-4.0).
MD
python3 - "$REPO" "$SRC" <<'PY'
import os, sys
from huggingface_hub import HfApi
repo, src = sys.argv[1], sys.argv[2]
api = HfApi(token=os.environ['HF_TOKEN'])
api.create_repo(repo, repo_type='model', exist_ok=True)
api.upload_folder(repo_id=repo, folder_path=src, allow_patterns=['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'README.md'],
                  commit_message='ATC-ASR 110M v1: int8 ONNX for the browser')
print(f'published https://huggingface.co/{repo}')
PY
echo "NEXT_PUBLIC_STT_MODEL_BASE=https://huggingface.co/$REPO/resolve/main/"
