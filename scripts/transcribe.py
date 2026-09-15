#!/usr/bin/env python3
"""Local CPU Whisper runner. stdout is one JSON value; stderr contains progress."""

import argparse
import json
import math
import os
from pathlib import Path
import sys

# Bound native libraries even when this runner is used outside the Node wrapper.
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def progress(value, phase):
    print(json.dumps({"type": "progress", "progress": value, "phase": phase}), file=sys.stderr, flush=True)


def cached_model(model, cache, download=False):
    from faster_whisper.utils import download_model

    candidate = Path(model).expanduser()
    location = str(candidate.resolve()) if candidate.is_dir() else download_model(
        model, cache_dir=str(cache), local_files_only=not download
    )
    for filename in ("model.bin", "config.json", "tokenizer.json"):
        file = Path(location) / filename
        if not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError("The speech model is incomplete. Run npm run setup:auto again.")
    return location


def load_model(location):
    from faster_whisper import WhisperModel

    return WhisperModel(location, device="cpu", compute_type="int8", cpu_threads=2,
                        num_workers=1, local_files_only=True)


def finite_time(value, duration):
    return round(max(0.0, min(duration, float(value))), 3)


def transcribe(input_path, location):
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    progress(2, "Checking audio")
    audio = decode_audio(str(input_path), sampling_rate=16000)
    duration = len(audio) / 16000
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("The extracted audio is empty.")
    vad_options = VadOptions(threshold=0.6, min_speech_duration_ms=250,
                             min_silence_duration_ms=500, speech_pad_ms=200)
    speech = get_speech_timestamps(audio, vad_options)
    if not speech:
        progress(100, "No speech detected")
        return {"language": "und", "duration": round(duration, 3), "segments": []}

    progress(8, "Loading speech model")
    model = load_model(location)
    progress(12, "Transcribing speech")
    segments, info = model.transcribe(
        audio, beam_size=5, word_timestamps=True, vad_filter=True,
        vad_parameters=vad_options, condition_on_previous_text=False,
        temperature=0.0, no_speech_threshold=0.55, log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4, hallucination_silence_threshold=1.0,
    )
    result = []
    for segment in segments:
        progress(min(99, round(12 + 87 * segment.end / duration)), "Transcribing speech")
        text = segment.text.strip()
        # VAD plus confidence checks suppress common silence/music hallucinations.
        # Speech recognition still cannot guarantee that every retained word is right.
        if not text or segment.avg_logprob < -1.0 or segment.no_speech_prob > 0.6 or segment.compression_ratio > 2.4:
            continue
        start = finite_time(segment.start, duration)
        end = finite_time(segment.end, duration)
        if end <= start:
            continue
        words = []
        for word in segment.words or []:
            word_start = finite_time(word.start, duration)
            word_end = finite_time(word.end, duration)
            if word.word.strip() and word_end > word_start:
                words.append({"start": word_start, "end": word_end, "word": word.word,
                              "probability": round(float(word.probability), 4)})
        if not words:
            continue
        result.append({"start": start, "end": end, "text": text, "words": words})
    progress(100, "Transcription complete")
    return {"language": info.language if result else "und", "duration": round(duration, 3), "segments": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "small"))
    parser.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("WHISPER_CACHE_DIR", str(Path(os.environ.get("DATA_DIR", "data")) / "models"))))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--download", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.download:
        os.environ["HF_HUB_OFFLINE"] = "1"
    if args.download:
        progress(0, "Downloading speech model")
        args.cache_dir.mkdir(parents=True, exist_ok=True)
    location = cached_model(args.model, args.cache_dir.resolve(), args.download)
    if args.check:
        import ctranslate2
        import onnxruntime  # noqa: F401: VAD must be installed too.
        if "int8" not in ctranslate2.get_supported_compute_types("cpu"):
            raise RuntimeError("This CPU does not support the configured int8 speech model.")
        print(json.dumps({"available": True, "model": args.model}))
    elif args.download:
        load_model(location)
        from faster_whisper.vad import get_vad_model
        get_vad_model()
        progress(100, "Speech model ready")
        print(json.dumps({"available": True, "model": args.model}))
    else:
        if not args.input or not args.input.is_file():
            raise RuntimeError("Choose an existing local audio file.")
        print(json.dumps(transcribe(args.input.resolve(), location), ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(json.dumps({"type": "error", "error": str(error)}), file=sys.stderr, flush=True)
        sys.exit(1)
