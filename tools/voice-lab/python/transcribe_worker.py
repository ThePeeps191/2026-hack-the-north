#!/usr/bin/env python3
"""Local faster-whisper worker. Audio never leaves this process except as text."""

from __future__ import annotations

import base64
import json
import os
import sys
import traceback


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def load_model():
    from faster_whisper import WhisperModel

    model_size = os.environ.get("WHISPER_MODEL", "base.en")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    threads = int(os.environ.get("WHISPER_CPU_THREADS", "4"))
    send(
        {
            "event": "loading",
            "model": model_size,
            "device": device,
            "computeType": compute_type,
        }
    )
    model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute_type,
        cpu_threads=threads,
    )
    send(
        {
            "event": "ready",
            "model": model_size,
            "device": device,
            "computeType": compute_type,
            "engine": "faster-whisper",
        }
    )
    return model


def transcribe(model, request: dict) -> str:
    import numpy as np

    pcm = np.frombuffer(base64.b64decode(request["pcm"]), dtype=np.float32).copy()
    if pcm.size == 0:
        return ""
    is_final = bool(request.get("isFinal", True))
    prompt = None
    if is_final and pcm.size >= 16000:
        prompt = request.get("initialPrompt") or (
            "Huddle teammates Maya, Alex, and Sam. TypeScript, React, Electron, "
            "App.tsx, function, const, Git, pull request."
        )
    segments, _info = model.transcribe(
        pcm,
        language="en",
        beam_size=1 if not is_final else 2,
        vad_filter=False,
        condition_on_previous_text=False,
        initial_prompt=prompt,
        without_timestamps=True,
        temperature=0.0,
        no_speech_threshold=0.6,
    )
    return "".join(segment.text for segment in segments).strip()


def main() -> int:
    try:
        model = load_model()
    except Exception as exc:  # noqa: BLE001
        send({"event": "error", "message": f"failed to load local Whisper model: {exc}"})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            send({"event": "error", "message": f"invalid JSON: {exc}"})
            continue
        if request.get("cmd") == "shutdown":
            send({"event": "bye"})
            return 0
        request_id = request.get("id")
        try:
            text = transcribe(model, request)
            send(
                {
                    "id": request_id,
                    "ok": True,
                    "text": text,
                    "isFinal": bool(request.get("isFinal", True)),
                }
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            send({"id": request_id, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
