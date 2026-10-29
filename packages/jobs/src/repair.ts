// Repair planning for effect segments whose output check found original people (segment.repair): which shots and slots the next pass covers.
// Pure functions; the runner executes the passes and the compose container cuts and blends the frames.

import type { CropBox, EffectRepair } from './models';

export interface RepairPass {
  /** Slots replaced in this pass, in reference image order. */
  slots: string[];
  /** Shot indices this pass re-renders. */
  shots: number[];
  /** Set when the pass repairs one person's box instead of the whole frame. */
  crop?: CropBox;
}

/**
 * The next pass for the first still-failing slot, or null when no failing slot can be repaired.
 * The first pass on a set of shots repairs the whole frame with the photos of every filled slot in them; the model replaces the most
 * prominent people first, and handing it everyone keeps it from putting one person's face on another. When a whole-frame pass on those
 * shots has already run and the slot has a crop box, the pass repairs that box alone; otherwise the whole frame again (with a new seed).
 */
export function nextRepairPass(
  repair: EffectRepair,
  filled: readonly string[],
  failing: readonly string[],
  done: readonly RepairPass[],
): RepairPass | null {
  const slot = failing.find((candidate) => repair.shots.some((slots) => slots.includes(candidate)));
  if (!slot) return null;
  const shots = repair.shots.flatMap((slots, i) => (slots.includes(slot) ? [i] : []));
  const same = (pass: RepairPass) => pass.shots.join() === shots.join();
  const crop = repair.crops?.[slot];
  if (crop && done.some((pass) => !pass.crop && same(pass))) return { slots: [slot], shots, crop };
  const present = new Set(shots.flatMap((i) => repair.shots[i]!));
  return { slots: filled.filter((candidate) => present.has(candidate)), shots };
}

/**
 * Frame ranges [start, end) of the given shots in the final cut, adjacent shots merged.
 * Shot i runs from cut i - 1 (0 for the first) to cut i (target for the last).
 */
export function shotFrames(
  cuts: readonly number[],
  target: number,
  fps: number,
  shots: readonly number[],
): [number, number][] {
  const bounds = [0, ...cuts, target].map((seconds) => Math.round(seconds * fps));
  const ranges: [number, number][] = [];
  for (const shot of [...shots].sort((a, b) => a - b)) {
    const start = bounds[shot]!;
    const end = bounds[shot + 1]!;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === start) last[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}
