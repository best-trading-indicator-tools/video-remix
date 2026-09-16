# Local face-position model

`face_detection_yunet_2023mar.onnx` is the OpenCV Zoo YuNet detector, bundled
under the accompanying MIT license. It detects face boxes; it does not identify
people or determine who is speaking from audio.

- Source: https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet
- Download: https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
- Size: 232,589 bytes
- SHA256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`

The Python worker verifies the checksum before using the model. No model or
media is downloaded at runtime. Install its CPU dependency with
`npm run setup:focus`.
