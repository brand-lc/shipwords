// Type declarations for compose.mjs: the container runs the .mjs directly with Node, tests import it from TypeScript.
export interface Segment {
  file: string;
  duration: number;
  target: number;
  fit?: 'stretch' | 'trim';
}
export interface Audio {
  file: string;
  start: number;
  duration: number;
}
export function buildFfmpegArgs(spec: {
  segments: Segment[];
  audio?: Audio | null;
  width: number;
  height: number;
  fps: number;
  output: string;
}): string[];
export function buildSilentArgs(input: string, output: string): string[];
export function parsePoints(text: string): [number, number][];
