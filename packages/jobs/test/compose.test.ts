import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, buildSilentArgs, parsePoints } from '../compose/compose.mjs';

// ffmpeg itself runs in the container; here we only check args: retime ratio, frame-count cut, concat order, optional audio.
describe('compose args', () => {
  const spec = {
    segments: [
      { file: 'a.mp4', duration: 5, target: 5.333 },
      { file: 'b.mp4', duration: 4, target: 2.688 },
    ],
    width: 720,
    height: 1280,
    fps: 24,
    output: 'out.mp4',
  };

  it('retimes each segment by target/duration, cuts to target frame count, concatenates in order and mixes the original track', () => {
    const args = buildFfmpegArgs({ ...spec, audio: { file: 'song.mp4', start: 1.375, duration: 8.021 } });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=1.066600*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=128');
    expect(graph).toContain('[1:v]setpts=0.672000*(PTS-STARTPTS)');
    expect(graph).toContain('trim=end_frame=65');
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[v]');
    expect(args).toEqual(
      expect.arrayContaining(['-ss', '1.375', '-t', '8.021', '-i', 'song.mp4', '-map', '2:a']),
    );
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('an extra model frame does not affect the retime ratio: 6.04s counts as 6s, actual length used only beyond 1.5 frames', () => {
    const graph = (duration: number) => {
      const args = buildFfmpegArgs({ ...spec, segments: [{ file: 'a.mp4', duration, target: 6.292 }] });
      return args[args.indexOf('-filter_complex') + 1]!;
    };
    expect(graph(6.041667)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(5.958333)).toContain('setpts=1.048667*(PTS-STARTPTS)');
    expect(graph(6.2)).toContain('setpts=1.014839*(PTS-STARTPTS)');
    expect(graph(6.041667)).toContain('trim=end_frame=151');
  });

  it('no audio mapping without a track; empty segments and non-positive durations throw', () => {
    expect(buildFfmpegArgs(spec)).not.toContain('-c:a');
    expect(() => buildFfmpegArgs({ ...spec, segments: [] })).toThrow(/no segments/);
    expect(() => buildFfmpegArgs({ ...spec, segments: [{ file: 'a', duration: 0, target: 1 }] })).toThrow(
      /positive/,
    );
  });

  it('silent version drops audio and copies the video stream as-is', () => {
    expect(buildSilentArgs('in.mp4', 'out.mp4')).toEqual(expect.arrayContaining(['-an', '-c:v', 'copy']));
  });
});

describe('output check points', () => {
  it('accepts 1–10 [x, y] pairs in 0–1, rejects anything else', () => {
    expect(parsePoints('[[0.48,0.5],[0.1,0.21]]')).toEqual([
      [0.48, 0.5],
      [0.1, 0.21],
    ]);
    for (const bad of [
      '[]',
      '[[0.5]]',
      '[[0.5,1.2]]',
      '[["0.5",0.5]]',
      '{"x":1}',
      JSON.stringify(Array(11).fill([0.5, 0.5])),
    ]) {
      expect(() => parsePoints(bad)).toThrow();
    }
    expect(() => parsePoints('not json')).toThrow();
  });
});
