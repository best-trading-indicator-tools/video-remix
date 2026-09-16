"""Local face positions for bounded, pre-extracted source frames. No identity recognition."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

# Keep NumPy/OpenCV's CPU use predictable even on large workstations.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[variable] = "1"

MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
MODEL = Path(__file__).resolve().parent / "models/face_detection_yunet_2023mar.onnx"


def detector():
    import cv2
    cv2.setNumThreads(1)
    cv2.ocl.setUseOpenCL(False)
    if hashlib.sha256(MODEL.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError("The bundled face detector failed its integrity check.")
    return cv2, cv2.FaceDetectorYN.create(str(MODEL), "", (320, 320), 0.85, 0.3, 100)


def distance(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def choose_face(faces, previous, seed):
    if not faces:
        return None
    if previous is not None:
        possible = [face for face in faces if distance(face, previous) < 0.3
                    and 0.25 < face["area"] / max(previous["area"], 1e-5) < 4]
        if not possible:
            return None
        return min(possible, key=lambda face: distance(face, previous) + abs(math.log(face["area"] / previous["area"])) * 0.035)
    if seed is not None:
        return min(faces, key=lambda face: distance(face, seed) - math.sqrt(face["area"]) * 0.04)
    return max(faces, key=lambda face: face["area"] * face["confidence"])


def simplify_path(points, tolerance=0.002):
    """Simplify by error at each source time, preserving hold-to-pan timing."""
    if len(points) < 3:
        return points
    before, after = points[0], points[-1]
    worst_error, worst_index = 0, 0
    for index, point in enumerate(points[1:-1], 1):
        ratio = (point["time"] - before["time"]) / max(1e-6, after["time"] - before["time"])
        expected = {axis: before[axis] + ratio * (after[axis] - before[axis]) for axis in ("x", "y")}
        error = distance(point, expected)
        if error > worst_error:
            worst_error, worst_index = error, index
    if worst_error <= tolerance:
        return [before, after]
    return simplify_path(points[:worst_index + 1], tolerance)[:-1] + simplify_path(points[worst_index:], tolerance)


def track_samples(samples, cuts, seed=None):
    """Track by spatial continuity, not identity or audio activity; reset per cut."""
    tracks = []
    detected_frames = 0
    multiple_faces = any(len(sample["faces"]) > 1 for sample in samples)
    for cut_index, cut in enumerate(cuts):
        cut_seed = cut.get("focalPoint") or seed
        selected = sorted((sample for sample in samples if sample["cutIndex"] == cut_index), key=lambda sample: sample["time"])
        previous = None
        last_seen = -math.inf
        observed = []
        for sample in selected:
            if sample["time"] - last_seen > 2:
                previous = None
            face = (sample["faces"][0] if sample["faces"] else None) if sample.get("selected") else choose_face(sample["faces"], previous, cut_seed)
            if face is not None:
                previous = face
                last_seen = sample["time"]
                detected_frames += 1
            observed.append({"time": sample["time"], "face": face})
        count = sum(item["face"] is not None for item in observed)
        coverage = count / max(1, len(observed))
        if count < min(2, len(observed)) or not observed or coverage < 0.4:
            continue

        fallback = cut_seed or {"x": 0.5, "y": 0.5}
        last_face = None
        last_seen = -math.inf
        smoothed = None
        last_time = cut["start"]
        keyframes = []
        for item in observed:
            face = item["face"]
            if face is not None:
                last_face = face
                last_seen = item["time"]
            target = face or (last_face if item["time"] - last_seen <= 1.25 else fallback)
            target = {"x": target["x"], "y": target["y"]}
            delta = max(0.01, item["time"] - last_time)
            if smoothed is None:
                smoothed = target
            else:
                alpha = 1 - math.exp(-delta / 0.3)
                for axis in ("x", "y"):
                    difference = target[axis] - smoothed[axis]
                    # Ignore sub-pixel detector noise, but keep sustained motion.
                    if abs(difference) > 0.008:
                        smoothed[axis] += max(-0.65 * delta, min(0.65 * delta, difference * alpha))
            point = {"time": round(item["time"], 4), "x": round(max(0, min(1, smoothed["x"])), 5), "y": round(max(0, min(1, smoothed["y"])), 5)}
            keyframes.append(point)
            last_time = item["time"]
        keyframes.insert(0, {**keyframes[0], "time": cut["start"]})
        keyframes.append({**keyframes[-1], "time": cut["end"]})
        # A constant-position lead-in needs its final hold point. Dropping it
        # would make a linear renderer pan before the person actually moves.
        compact = simplify_path(keyframes)
        tracks.append({"cutIndex": cut_index, "start": cut["start"], "end": cut["end"], "keyframes": compact, "coverage": round(coverage, 3)})
    # Keep FFmpeg's eventual crop expression small. Remove the least important
    # points first, retaining every cut boundary and actual direction changes.
    def removable(track):
        points = track["keyframes"]
        for index in range(1, len(points) - 1):
            before, point, after = points[index - 1:index + 2]
            ratio = (point["time"] - before["time"]) / max(1e-6, after["time"] - before["time"])
            expected = {axis: before[axis] + ratio * (after[axis] - before[axis]) for axis in ("x", "y")}
            yield distance(point, expected), index
    for track in tracks:
        while len(track["keyframes"]) > 120:
            _, index = min(removable(track))
            track["keyframes"].pop(index)
    while sum(len(track["keyframes"]) for track in tracks) > 240:
        _, track_index, point_index = min((error, index, point_index) for index, track in enumerate(tracks) for error, point_index in removable(track))
        tracks[track_index]["keyframes"].pop(point_index)
    status = "no-face" if not tracks else "tracked" if len(tracks) == len(cuts) and all(track["coverage"] >= 0.8 for track in tracks) else "partial"
    return {"status": status, "tracks": tracks, "sampledFrames": len(samples), "detectedFrames": detected_frames, "multipleFaces": multiple_faces}


def analyze(manifest):
    cv2, model = detector()
    frames = manifest["frames"]
    if not 1 <= len(frames) <= 180:
        raise ValueError("Face framing requires between 1 and 180 samples.")
    samples = []
    for entry in frames:
        image = cv2.imread(entry["path"], cv2.IMREAD_COLOR)
        if image is None or max(image.shape[:2]) > 640:
            raise ValueError("A sampled frame could not be read safely.")
        height, width = image.shape[:2]
        model.setInputSize((width, height))
        _, result = model.detect(image)
        faces = []
        for row in result if result is not None else []:
            x, y, face_width, face_height = [float(value) for value in row[:4]]
            area = face_width * face_height / (width * height)
            if face_width < 12 or face_height < 12 or area < 0.001 or area > 0.8:
                continue
            faces.append({"x": max(0, min(1, (x + face_width / 2) / width)), "y": max(0, min(1, (y + face_height / 2) / height)), "area": area, "confidence": float(row[14])})
        samples.append({"cutIndex": entry["cutIndex"], "time": entry["time"], "faces": faces})
    return track_samples(samples, manifest["cuts"], manifest.get("seed"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--manifest")
    arguments = parser.parse_args()
    if arguments.check:
        detector()
        print(json.dumps({"available": True, "detector": "yunet-2023mar"}))
        return
    if not arguments.manifest:
        parser.error("--manifest is required")
    file = Path(arguments.manifest)
    if file.stat().st_size > 128_000:
        raise ValueError("The face-framing request is too large.")
    print(json.dumps(analyze(json.loads(file.read_text())), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # The adapter returns safe diagnostics; private filenames stay local.
        print("Local face framing could not inspect these samples.", file=sys.stderr)
        sys.exit(1)
