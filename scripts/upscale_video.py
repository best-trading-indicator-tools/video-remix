"""Streaming Real-ESRGAN video inference. No network and no extracted frame directory.

Plans are internal server files. The original soundtrack is handled by the main
renderer; this worker only reconstructs the selected, retimed source pictures.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def verified_model():
    manifest = json.loads((ROOT / 'upscale-model.json').read_text())
    model = ROOT / 'models' / manifest['filename']
    digest = hashlib.sha256()
    with model.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != manifest['sha256']:
        raise RuntimeError('Real-ESRGAN model integrity check failed. Run npm run setup:upscale again.')
    return model


def read_frame(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            if data:
                raise RuntimeError('Incomplete frame during AI upscaling.')
            return None
        data.extend(chunk)
    return data


def stop(child):
    if child is None:
        return
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
    child.wait()


def enhance(frame, net, device, torch, np):
    height, width = frame.shape[:2]
    output = np.empty((height * 4, width * 4, 3), dtype=np.uint8)
    # 34 convolutions need 34 pixels of context. Overlap prevents tile seams.
    tile, pad = 192, 36
    with torch.inference_mode():
        for y in range(0, height, tile):
            for x in range(0, width, tile):
                right, bottom = min(x + tile, width), min(y + tile, height)
                left_in, top_in = max(0, x - pad), max(0, y - pad)
                right_in, bottom_in = min(width, right + pad), min(height, bottom + pad)
                pixels = frame[top_in:bottom_in, left_in:right_in]
                tensor = torch.from_numpy(pixels.transpose(2, 0, 1).copy()).to(device=device, dtype=torch.float32)[None] / 255
                prediction = net(tensor)[0]
                if not torch.isfinite(prediction).all():
                    raise RuntimeError('Real-ESRGAN returned invalid pixels. Try another device or reinstall the local model.')
                prediction = prediction[:, (y - top_in) * 4:(bottom - top_in) * 4, (x - left_in) * 4:(right - left_in) * 4]
                pixels = prediction.permute(1, 2, 0).clamp(0, 1).mul(255).round().to(torch.uint8).cpu().numpy()
                output[y * 4:bottom * 4, x * 4:right * 4] = pixels
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--plan')
    args = parser.parse_args()
    import numpy as np
    import torch
    from PIL import Image
    from vendor.realesrgan.srvgg_arch import SRVGGNetCompact

    torch.set_num_threads(min(6, os.cpu_count() or 1))
    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    net = SRVGGNetCompact(num_conv=32)
    weights = torch.load(verified_model(), map_location='cpu', weights_only=True)
    net.load_state_dict(weights.get('params_ema', weights.get('params', weights)), strict=True)
    net = net.eval().to(device)
    # Actually execute the model so setup catches incompatible GPU runtimes.
    if args.check:
        sample = enhance(np.full((16, 16, 3), 127, dtype=np.uint8), net, device, torch, np)
        if sample.shape != (64, 64, 3) or not sample.any():
            raise RuntimeError('Real-ESRGAN self-check failed.')
        print(json.dumps({'available': True, 'device': device}), flush=True)
        return
    if not args.plan:
        parser.error('--plan is required')
    plan = json.loads(Path(args.plan).read_text())
    width, height = plan['width'], plan['height']
    out_width, out_height = plan['outputWidth'], plan['outputHeight']
    if any(not isinstance(n, int) or n < 2 or n > 16384 for n in [width, height, out_width, out_height]):
        raise RuntimeError('Invalid AI upscaling dimensions.')
    if width * height > 17_000_000 or out_width * out_height > 67_000_000:
        raise RuntimeError('AI upscaling supports source frames up to 16 megapixels and reconstructed frames up to 64 megapixels.')
    fps, duration = plan['fps'], plan['duration']
    if not math.isfinite(fps) or not 0 < fps <= 240 or not math.isfinite(duration) or duration <= 0:
        raise RuntimeError('Invalid AI upscaling duration or frame rate.')
    expected = max(1, math.ceil(duration * fps))
    common = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2']
    decode = common + plan['inputArgs'] + ['-map', '0:V:0', '-an', '-sn', '-dn', '-vf',
        ','.join(plan['filters'] + [f'fps={fps}:start_time=0', 'format=rgb24']),
        '-t', str(duration), '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']
    encode = common + ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{out_width}x{out_height}', '-r', str(fps),
        '-i', 'pipe:0', '-an', '-c:v', 'ffv1', '-level', '3', '-threads', '1', '-pix_fmt', 'bgr0', plan['output']]
    decoder = encoder = None
    with tempfile.TemporaryFile() as decode_log, tempfile.TemporaryFile() as encode_log:
        try:
            decoder = subprocess.Popen(decode, stdout=subprocess.PIPE, stderr=decode_log, stdin=subprocess.DEVNULL)
            encoder = subprocess.Popen(encode, stdin=subprocess.PIPE, stderr=encode_log, stdout=subprocess.DEVNULL)
            count = 0
            while True:
                raw = read_frame(decoder.stdout, width * height * 3)
                if raw is None:
                    break
                frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)
                restored = Image.fromarray(enhance(frame, net, device, torch, np))
                if restored.size != (out_width, out_height):
                    restored = restored.resize((out_width, out_height), Image.Resampling.LANCZOS)
                encoder.stdin.write(restored.tobytes())
                count += 1
                print(json.dumps({'progress': min(99, 100 * count / expected), 'device': device}), flush=True)
            encoder.stdin.close()
            decode_code, encode_code = decoder.wait(), encoder.wait()
            if decode_code or encode_code or count == 0:
                raise RuntimeError('Could not read or write the AI-upscaled video.')
        except Exception:
            for log in (decode_log, encode_log):
                log.seek(max(0, log.seek(0, 2) - 1500))
                sys.stderr.write(log.read().decode(errors='replace'))
            raise
        finally:
            stop(decoder)
            stop(encoder)
    print(json.dumps({'progress': 100, 'device': device}), flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
