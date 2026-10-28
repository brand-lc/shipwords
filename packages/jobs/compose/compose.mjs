// Effect video compose: retime each segment (model render or base clip) back to real speed, concatenate in order, then mix in the original track.
// Depends only on Node built-ins and the image's ffmpeg; server.mjs uses it for HTTP requests, tests call buildFfmpegArgs directly.

/**
 * @typedef {{ file: string; duration: number; target: number; fit?: 'stretch' | 'trim' }} Segment
 *   file: local file; duration: the file's actual length (s); target: length it should occupy in the output (s).
 *   fit: stretch (default) retimes the whole segment to target; trim takes the first target seconds at real speed.
 * @typedef {{ file: string; start: number; duration: number }} Audio
 *   Original track: cut duration seconds starting at file's start second.
 */

/**
 * Build ffmpeg args. Segments are scaled to width×height and fps, retimed by target/duration, concatenated, and optionally mixed with an audio track.
 * @param {{ segments: Segment[]; audio?: Audio | null; width: number; height: number; fps: number; output: string }} spec
 */
export function buildFfmpegArgs(spec) {
  const { segments, audio, width, height, fps, output } = spec;
  if (!segments.length) throw new Error('no segments');
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const segment of segments) {
    if (!(segment.duration > 0 && segment.target > 0)) throw new Error('segment durations must be positive');
    args.push('-i', segment.file);
  }
  if (audio) args.push('-ss', String(audio.start), '-t', String(audio.duration), '-i', audio.file);

  const frames = (seconds) => Math.round(seconds * fps);
  // Models render in whole seconds but often add 1 frame (6s comes out as 6.04s); using the actual length would skew the whole segment and break lip sync.
  // Within 1.5 frames we use the whole second; the extra frames are trimmed by the frame-count cut below.
  const nominal = (seconds) => {
    const whole = Math.round(seconds);
    return whole > 0 && Math.abs(seconds - whole) <= 1.5 / fps ? whole : seconds;
  };
  const filters = segments.map((segment, i) => {
    const ratio =
      segment.fit === 'trim' ? '1.000000' : (segment.target / nominal(segment.duration)).toFixed(6);
    // Retime first, then normalize frame rate, then cut by frame count so each segment is exact and the concat doesn't drift.
    return (
      `[${i}:v]setpts=${ratio}*(PTS-STARTPTS),scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${fps},tpad=stop_mode=clone:stop=${fps},trim=end_frame=${frames(segment.target)},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const inputs = segments.map((_, i) => `[v${i}]`).join('');
  filters.push(`${inputs}concat=n=${segments.length}:v=1:a=0[v]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (audio) args.push('-map', `${segments.length}:a`, '-c:a', 'aac', '-b:a', '160k', '-shortest');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  );
  return args;
}

/** Output check points: a JSON list of 1–10 [x, y] pairs in 0–1 (face centers as fractions of the frame). Throws on anything else. */
export function parsePoints(text) {
  const points = JSON.parse(text);
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    points.length > 10 ||
    !points.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((value) => typeof value === 'number' && value >= 0 && value <= 1),
    )
  )
    throw new Error('bad points');
  return points;
}

/** Silent version: drop the audio track, copy the video stream as-is. */
export function buildSilentArgs(input, output) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-an',
    '-c:v',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ];
}
