"""Swap check: is the original person still in the model output?

Usage: python3 faces.py <output.mp4> <original.mp4> <seconds> '<[[x, y] or [x, y, t], ...]>'
For each point (a face center in the original as fractions of width and height, read from the frame at t seconds, the first frame
when t is omitted) prints, as a JSON list in the same order,
the highest cosine similarity between that original face and any face in 16 frames spread over the first `seconds` of the output.
A missed swap scores 0.85+, a swapped person stays under 0.4. A point with no face in the original prints 0.
Models: OpenCV Zoo YuNet (detection) and SFace (recognition), baked into the image under /app/models.
"""
import json
import os
import sys

import cv2

MODELS = os.environ.get('FACE_MODELS', '/app/models')
# At least 16 frames, and 2 per second for long clips: a whole-clip edit can keep the original person for just a second or two.
SAMPLES = 16
SAMPLES_PER_SECOND = 2
detector = cv2.FaceDetectorYN.create(f'{MODELS}/yunet.onnx', '', (320, 320), 0.6)
recognizer = cv2.FaceRecognizerSF.create(f'{MODELS}/sface.onnx', '')


def faces(image):
    """(center x, center y, feature) for each face that isn't tiny (posters and photos on the shelves don't count)."""
    height, width = image.shape[:2]
    detector.setInputSize((width, height))
    _, found = detector.detect(image)
    result = []
    for face in found if found is not None else []:
        if face[2] * face[3] < 0.003 * width * height:
            continue
        feature = recognizer.feature(recognizer.alignCrop(image, face))
        result.append(((face[0] + face[2] / 2) / width, (face[1] + face[3] / 2) / height, feature))
    return result


def frames(path, seconds, count):
    capture = cv2.VideoCapture(path)
    end = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = capture.get(cv2.CAP_PROP_FPS)
    if fps > 0:
        end = min(end, int(seconds * fps))
    result = []
    for i in range(count):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(end * (i + 0.5) / count))
        ok, image = capture.read()
        if ok:
            result.append(image)
    return result


def original_frame(path, seconds):
    capture = cv2.VideoCapture(path)
    if seconds > 0:
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
    ok, image = capture.read()
    if not ok:
        raise SystemExit(f'cannot read the original clip at {seconds}s')
    return image


def main():
    output, original, seconds, points = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
    by_time = {}
    targets = []
    for point in points:
        x, y = point[0], point[1]
        t = point[2] if len(point) > 2 else 0.0
        if t not in by_time:
            by_time[t] = faces(original_frame(original, t))
        originals = by_time[t]
        nearest = min(originals, key=lambda f: (f[0] - x) ** 2 + (f[1] - y) ** 2, default=None)
        # Only trust a face that is actually near the configured point.
        targets.append(nearest[2] if nearest and (nearest[0] - x) ** 2 + (nearest[1] - y) ** 2 < 0.15 ** 2 else None)
    sampled = frames(output, seconds, max(SAMPLES, round(seconds * SAMPLES_PER_SECOND)))
    if not sampled:
        raise SystemExit('cannot read the output')
    found = [face[2] for image in sampled for face in faces(image)]
    scores = []
    for target in targets:
        if target is None:
            scores.append(0.0)
            continue
        best = max((recognizer.match(target, feature, cv2.FaceRecognizerSF_FR_COSINE) for feature in found), default=0.0)
        scores.append(round(max(0.0, float(best)), 3))
    print(json.dumps(scores))


if __name__ == '__main__':
    main()
