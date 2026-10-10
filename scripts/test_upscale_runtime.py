"""Fault-injection tests run without torch or a GPU on every supported platform."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import upscale_video as worker


class RecoveryTests(unittest.TestCase):
    def runner(self, device='mps', net=None):
        torch = SimpleNamespace(mps=SimpleNamespace(empty_cache=Mock()), cuda=SimpleNamespace(empty_cache=Mock()))
        return worker.Upscaler(net or Mock(), torch, None, device, report=Mock())

    def test_gpu_failure_retries_same_frame_on_cpu_and_stays_there(self):
        runner = self.runner()
        frame, result = object(), object()
        with patch.object(worker, 'enhance', side_effect=[RuntimeError('Unsupported GPU operation'), result, result]) as infer:
            self.assertIs(runner(frame), result)
            self.assertIs(runner(frame), result)
            self.assertEqual([call.args[2] for call in infer.call_args_list], ['mps', 'cpu', 'cpu'])
            self.assertTrue(all(call.args[0] is frame for call in infer.call_args_list))
        self.assertIsNotNone(runner.fallback)

    def test_gpu_memory_reduces_tiles_before_cpu_fallback(self):
        runner = self.runner('cuda')
        with patch.object(worker, 'enhance', side_effect=[RuntimeError('CUDA out of memory')] * 3 + ['pixels']) as infer:
            self.assertEqual(runner('frame'), 'pixels')
            self.assertEqual([(c.args[2], c.args[5]) for c in infer.call_args_list],
                             [('cuda', 192), ('cuda', 96), ('cuda', 48), ('cpu', 48)])

    def test_cpu_memory_retries_are_bounded(self):
        runner = self.runner('cpu')
        with patch.object(worker, 'enhance', side_effect=MemoryError('allocation failed')) as infer:
            with self.assertRaisesRegex(RuntimeError, 'CPU AI upscaling failed'):
                runner('frame')
            self.assertEqual(infer.call_count, 3)

    def test_cpu_other_errors_do_not_loop_or_substitute_resizing(self):
        with patch.object(worker, 'enhance', side_effect=RuntimeError('invalid pixels')) as infer:
            with self.assertRaisesRegex(RuntimeError, 'invalid pixels'):
                self.runner('cpu')('frame')
            self.assertEqual(infer.call_count, 1)

    def test_gpu_initialization_can_fail_before_first_frame(self):
        net = Mock()
        net.to.side_effect = [RuntimeError('GPU driver is missing'), None]
        self.assertEqual(self.runner(net=net).device, 'cpu')

    def test_read_frame_rejects_partial_video_data(self):
        from io import BytesIO
        self.assertEqual(worker.read_frame(BytesIO(b'abcd'), 4), b'abcd')
        self.assertIsNone(worker.read_frame(BytesIO(), 4))
        with self.assertRaisesRegex(RuntimeError, 'Incomplete frame'):
            worker.read_frame(BytesIO(b'abc'), 4)

    def test_incomplete_ffmpeg_is_rejected_before_rendering(self):
        with patch.object(worker.subprocess, 'run', side_effect=[None, SimpleNamespace(stdout=' scale V->V\n fps V->V\n')]):
            with self.assertRaisesRegex(RuntimeError, 'FFmpeg is missing.*drawtext'):
                worker.check_ffmpeg()


if __name__ == '__main__':
    unittest.main()
