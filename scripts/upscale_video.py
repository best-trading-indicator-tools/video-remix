"""Streaming Real-ESRGAN video inference. No network and no extracted frame directory.

Plans are internal server files. The original soundtrack is handled by the main
renderer; this worker only reconstructs the selected, retimed source pictures.
"""
import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import re
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


def check_ffmpeg():
    subprocess.run(['ffprobe', '-version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    for option, required in [('-filters', ('scale', 'fps', 'format', 'movie', 'drawtext', 'subtitles')),
                             ('-encoders', ('ffv1', 'libx264', 'aac')),
                             ('-bsfs', ('filter_units',))]:
        result = subprocess.run(['ffmpeg', '-hide_banner', option], check=True, capture_output=True, text=True, timeout=15)
        missing = [name for name in required if not re.search(r'\s' + name + r'\s', result.stdout)]
        if missing:
            raise RuntimeError('FFmpeg is missing ' + ', '.join(missing) +
                               '. Install a full FFmpeg build. On Mac: brew install ffmpeg-full, then put its bin folder first on PATH.')


def enhance(frame, net, device, torch, np, tile=192):
    height, width = frame.shape[:2]
    output = np.empty((height * 4, width * 4, 3), dtype=np.uint8)
    # 34 convolutions need 34 pixels of context. Overlap prevents tile seams.
    pad = 36
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


class Upscaler:
    """Retry the same frame with less memory, then keep using CPU after GPU failure."""
    def __init__(self, net, torch, np, requested='auto', report=None):
        if requested not in ('auto', 'cpu', 'mps', 'cuda'):
            raise ValueError('UPSCALE_DEVICE must be auto, cpu, mps, or cuda.')
        self.net, self.torch, self.np = net, torch, np
        self.device = requested if requested != 'auto' else (
            'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
        self.tile = 192
        self.report = report or (lambda message: print(json.dumps({'status': message}), flush=True))
        self.fallback = None
        try:
            self.net.to(self.device)
        except (RuntimeError, NotImplementedError, AssertionError):
            if self.device == 'cpu':
                raise
            self.use_cpu()

    def clear_cache(self):
        gc.collect()
        try:
            if self.device == 'mps':
                self.torch.mps.empty_cache()
            elif self.device == 'cuda':
                self.torch.cuda.empty_cache()
        except (RuntimeError, AssertionError):
            pass

    def use_cpu(self):
        self.net.to('cpu')
        self.clear_cache()
        self.device = 'cpu'
        self.fallback = 'GPU unavailable; continuing with CPU AI (slower).'
        self.report(self.fallback)

    def __call__(self, frame):
        while True:
            # Exit the exception block before retrying, releasing tensors held by
            # the traceback. Never send a partially reconstructed frame to FFmpeg.
            retry = None
            try:
                return enhance(frame, self.net, self.device, self.torch, self.np, self.tile)
            except (RuntimeError, NotImplementedError, MemoryError) as error:
                memory_error = isinstance(error, MemoryError) or any(word in str(error).lower()
                    for word in ('out of memory', 'allocate memory', 'allocation failed'))
                if memory_error and self.tile > 48:
                    retry = 'smaller'
                elif self.device != 'cpu':
                    retry = 'cpu'
                else:
                    raise RuntimeError('CPU AI upscaling failed. Close other applications or try a smaller source video. '
                                       + str(error)) from error
            self.clear_cache()
            if retry == 'smaller':
                self.tile //= 2
                self.report('Reducing AI tile size to fit available memory.')
            else:
                self.use_cpu()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--plan')
    parser.add_argument('--device', choices=['auto', 'cpu', 'mps', 'cuda'], default=os.getenv('UPSCALE_DEVICE', 'auto'))
    args = parser.parse_args()
    import numpy as np
    import torch
    from PIL import Image
    from vendor.realesrgan.srvgg_arch import SRVGGNetCompact

    torch.set_num_threads(min(6, os.cpu_count() or 1))
    net = SRVGGNetCompact(num_conv=32)
    weights = torch.load(verified_model(), map_location='cpu', weights_only=True)
    net.load_state_dict(weights.get('params_ema', weights.get('params', weights)), strict=True)
    upscaler = Upscaler(net.eval(), torch, np, args.device)
    # Actually execute the model so setup catches incompatible GPU runtimes.
    if args.check:
        check_ffmpeg()
        sample = upscaler(np.full((32, 32, 3), 127, dtype=np.uint8))
        if sample.shape != (128, 128, 3) or not sample.any():
            raise RuntimeError('Real-ESRGAN self-check failed.')
        print(json.dumps({'available': True, 'device': upscaler.device, 'fallback': upscaler.fallback}), flush=True)
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
                restored = Image.fromarray(upscaler(frame))
                if restored.size != (out_width, out_height):
                    restored = restored.resize((out_width, out_height), Image.Resampling.LANCZOS)
                encoder.stdin.write(restored.tobytes())
                count += 1
                print(json.dumps({'progress': min(99, 100 * count / expected), 'device': upscaler.device}), flush=True)
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
    print(json.dumps({'progress': 100, 'device': upscaler.device}), flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
