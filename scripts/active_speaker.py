"""CPU TalkNet inference on selected, small local clips. No network access."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from speaker_focus import detector, track_samples

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor/talknet"))
MODEL_HASH = "d985ddd07dca08864a28337726f5b7d91b6426bebc7327f0e9b21cf9ff1cc937"


def load_network(weights):
    import torch
    from model.talkNetModel import talkNetModel
    torch.set_num_threads(2)
    if hashlib.sha256(Path(weights).read_bytes()).hexdigest() != MODEL_HASH:
        raise ValueError("Active-speaker model integrity check failed.")
    state = torch.load(weights, map_location="cpu", weights_only=True)
    network = talkNetModel().eval()
    network.load_state_dict({key.removeprefix("model."): value for key, value in state.items() if key.startswith("model.")}, strict=True)
    classifier = torch.nn.Linear(256, 2).eval()
    classifier.load_state_dict({key.removeprefix("lossAV.FC."): value for key, value in state.items() if key.startswith("lossAV.FC.")}, strict=True)
    return torch, network, classifier


def select_speaker(faces, previous_id, pending_id, pending_since, last_switch, time):
    """Switch only after a sustained, confident lead; hold the shot during silence."""
    ranked = sorted(faces, key=lambda face: face.get("score", -100), reverse=True)
    current = next((face for face in faces if face["id"] == previous_id), None)
    best = ranked[0] if ranked else None
    decisive = best is not None and best.get("score", -100) > 0.5 and (len(ranked) == 1 or best["score"] - ranked[1]["score"] > 0.4)
    if not decisive:
        return current, None, time, last_switch
    if current is None or best["id"] == previous_id:
        return best, None, time, last_switch if current else time
    if pending_id != best["id"]:
        return current, best["id"], time, last_switch
    if time - pending_since >= 0.4 and time - last_switch >= 1.5:
        return best, None, time, time
    return current, pending_id, pending_since, last_switch


def face_crop(cv2, np, frame, face):
    x, y, width, height = face["box"]
    size = max(width, height) / 2
    pad = math.ceil(size * 1.8)
    image = cv2.copyMakeBorder(frame, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(110, 110, 110))
    cx, cy = x + width / 2 + pad, y + height / 2 + pad
    crop = image[int(cy-size):int(cy+size*1.8), int(cx-size*1.4):int(cx+size*1.4)]
    if not crop.size:
        return np.full((112, 112), 110, dtype=np.uint8)
    resized = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (224, 224))
    return resized[56:168, 56:168]


def inspect_clip(entry, cv2, detector_model, torch, network, classifier):
    import numpy as np
    from scipy.io import wavfile
    from python_speech_features import mfcc
    sample_rate, audio = wavfile.read(entry["audio"])
    if sample_rate != 16000 or audio.ndim != 1:
        raise ValueError("Expected mono 16 kHz audio.")
    capture = cv2.VideoCapture(entry["video"])
    histories, samples = {}, []
    frame_index, next_id = 0, 0
    multiple = False
    previous_id, pending_id, pending_since, last_switch = None, None, 0, -math.inf
    speaking_samples = 0
    try:
        while True:
            frames, detections = [], []
            for _ in range(100):  # Four seconds at 25 fps: bounded RAM even for large originals.
                ok, frame = capture.read()
                if not ok:
                    break
                if max(frame.shape[:2]) > 640:
                    raise ValueError("Analysis clip exceeds the frame size limit.")
                height, width = frame.shape[:2]
                absolute = frame_index + len(frames)
                if absolute % 5 == 0:
                    detector_model.setInputSize((width, height))
                    _, detected = detector_model.detect(frame)
                    faces = []
                    used = set()
                    rows = sorted(detected if detected is not None else [], key=lambda row: float(row[2]*row[3]), reverse=True)[:4]
                    for row in rows:
                        x, y, w, h = [float(v) for v in row[:4]]
                        if w < 12 or h < 12:
                            continue
                        cx, cy = (x+w/2)/width, (y+h/2)/height
                        matches = [(math.hypot(cx-f["x"], cy-f["y"]), ident) for ident, f in histories.items()
                                   if ident not in used and absolute-f["frame"] <= 10 and 0.4 < (w*h/(width*height))/f["area"] < 2.5]
                        distance, ident = min(matches, default=(math.inf, -1))
                        if distance > 0.15:
                            ident = next_id; next_id += 1
                        used.add(ident)
                        face = {"id": ident, "x": cx, "y": cy, "box": [x,y,w,h], "area": w*h/(width*height), "confidence": float(row[14]), "frame": absolute}
                        histories[ident] = face; faces.append(face)
                    histories = {ident: face for ident, face in histories.items() if absolute-face["frame"] <= 10}
                detections.append([dict(face) for face in faces]); frames.append(frame)
            if not frames:
                break
            multiple = multiple or any(len(faces) > 1 for faces in detections)
            identities = sorted({face["id"] for faces in detections for face in faces})
            scores = {}
            start_sample = frame_index * 640
            waveform = audio[start_sample:start_sample + len(frames)*640 + 400]
            waveform = np.pad(waveform, (0, max(0, len(frames)*640 + 400-len(waveform))))
            features = mfcc(waveform, 16000, numcep=13, winlen=0.025, winstep=0.010)[:len(frames)*4]
            features = np.pad(features, ((0, max(0, len(frames)*4-len(features))), (0,0)), mode="edge")
            with torch.inference_mode():
                audio_embedding = network.forward_audio_frontend(torch.from_numpy(features.astype(np.float32)).unsqueeze(0))
                for ident in identities:
                    observed = [(i, next((face for face in faces if face["id"] == ident), None)) for i, faces in enumerate(detections)]
                    visible = [(i, face) for i, face in observed if face is not None]
                    if len(visible) < min(15, len(frames)):
                        continue
                    crops = []
                    for index, face in observed:
                        nearest = face or min(visible, key=lambda pair: abs(pair[0]-index))[1]
                        crops.append(face_crop(cv2, np, frames[index], nearest))
                    visual_embedding = network.forward_visual_frontend(torch.from_numpy(np.asarray(crops, dtype=np.float32)).unsqueeze(0))
                    a, v = network.forward_cross_attention(audio_embedding, visual_embedding)
                    raw = classifier(network.forward_audio_visual_backend(a, v))[:, 1].numpy()
                    scores[ident] = np.convolve(np.pad(raw, (5,5), mode="edge"), np.ones(11)/11, mode="valid")
            for index in range(0, len(frames), 5):
                time = entry["start"] + (frame_index+index)/25
                if time >= entry["end"]:
                    break
                faces = [{**face, "score": float(scores[face["id"]][index]) if face["id"] in scores else -100} for face in detections[index]]
                chosen, pending_id, pending_since, last_switch = select_speaker(faces, previous_id, pending_id, pending_since, last_switch, time)
                if chosen:
                    previous_id = chosen["id"]
                    if chosen["score"] > 0.5:
                        speaking_samples += 1
                # In uncertain/offscreen speech hold a visible person; never guess that a missing person is speaking.
                if chosen is None and faces:
                    seed = entry.get("focalPoint") or {"x":0.5,"y":0.5}
                    chosen = min(faces, key=lambda face: math.hypot(face["x"]-seed["x"], face["y"]-seed["y"]))
                    previous_id = chosen["id"]
                samples.append({"cutIndex": entry["cutIndex"], "time": time, "faces": [chosen] if chosen else [], "selected": True})
            frame_index += len(frames)
            if frame_index > 15000:
                raise ValueError("Analysis interval is too long.")
    finally:
        capture.release()
    return samples, multiple, speaking_samples


def analyze(manifest):
    torch, network, classifier = load_network(manifest["weights"])
    cv2, model = detector()
    samples, multiple, speaking = [], False, 0
    for clip in manifest["clips"]:
        selected, faces, count = inspect_clip(clip, cv2, model, torch, network, classifier)
        samples.extend(selected); multiple = multiple or faces; speaking += count
    result = track_samples(samples, manifest["cuts"], manifest.get("seed"))
    result["multipleFaces"] = multiple
    result["reason"] = "TalkNet compared local audio with visible face motion. Review speaker changes; overlapping or offscreen speech may keep the previous frame."
    if result["tracks"] and speaking < len(samples)*0.6:
        result["status"] = "partial"
        result["reason"] = "Some speech could not be assigned confidently. Those moments keep a visible person near the previous or manual frame. Review the preview."
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest")
    parser.add_argument("--check")
    arguments = parser.parse_args()
    try:
        if arguments.check:
            load_network(arguments.check); detector()
            print(json.dumps({"available": True}))
        else:
            print(json.dumps(analyze(json.loads(Path(arguments.manifest).read_text())), allow_nan=False))
    except Exception:
        print("Local active-speaker analysis could not complete.", file=sys.stderr)
        sys.exit(1)
