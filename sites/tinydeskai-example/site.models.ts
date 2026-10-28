import { defineModels } from '@shipwords/jobs/models';

// One effect, based on the shot structure of the viral TikTok Tiny Desk clip (skips the first 1.4 s side view of the singer, about 17.7 s).
// Same price for 1–5 people: 5 equal slots in any combination, at least 1 upload. Empty slots keep the original coaches (celebrities first).
// Only segments with an uploaded slot are rendered; the rest use the original segment at compose time. At most 4 segments render.
// The per-order cap assumes the worst case of all 5 people (all 4 segments rendered).
// Reference videos and base clips live in R2 under assets/tinydesk/:
// band and sax references are the original retimed to whole seconds (at least 4 s, restored at compose); base clips are the original speed (*-original.mp4),
// so untouched segments skip the retime round trip and avoid band 1 repeating a frame every 16 frames. Empty slots keep the original coach.
// Tested: celebrity photos generate, and swapping one person against the original reference leaves the other coaches intact (README).
// Upstream is Seedance 2.0 mini in reference mode; prompts do not mention lip sync. Costs are in the README.
// Tried fast: it also misses the swap now and then and costs 2.2x mini, so we stayed on mini.
// Hats in the photo edit (A/B tested): when the keyboard slot wears exactly the original outfit (including the G cap), the model treats the photo as the original person and does not swap; without the cap it swaps.
// The lead slot is the opposite: the A cap anchors the model to the original shot, and removing it redraws the whole shot, so the lead keeps the cap. Occasional missed swaps are caught by the output check (lead.check).
// Before generating, GPT Image 2.5 Sunburst turns the user's photo into a waist-up shot wearing this slot's original outfit:
// the image sets the clothes, the prompt does not mention them. Each segment also takes its original audio as reference (retimed like the video), which clearly improves lip sync (README v6–v8).

// Keep prompts minimal: mentioning outfit, mouth, expression or props in front of the mouth makes lip sync worse (MediaPipe measurements, see README).
const KEEP = 'Keep everything else from @video1 the same.';
const SING = 'They are singing along to @audio1.';

/** Photo edit: waist-up shot of the same person in this slot's original outfit, with a uniform background and light. */
const outfit = (clothes: string) =>
  `Same person as in the reference photo, same face, waist-up photo, facing the camera, wearing ${clothes}. Plain light wall background, soft even daylight, realistic photo.`;

const BAND_SLOTS = {
  keys: 'the person seated at the keyboard in the front',
  backLeft: 'the person standing at the back left',
  backRight: 'the person standing at the back right',
} as const;

/** Band shot: describe only the filled slots; everyone else stays as is. */
function bandPrompt(images: Readonly<Record<string, string>>) {
  const swaps = Object.entries(BAND_SLOTS)
    .filter(([slot]) => images[slot])
    .map(([slot, who]) => `${who} with the person in ${images[slot]}`);
  return `In @video1, replace ${swaps.join('; ')}. ${SING} ${KEEP}`;
}

// Generated audio off: the original song is mixed in at compose.
const VIDEO = { resolution: '720p', aspect_ratio: '9:16', generate_audio: false } as const;

const lead = {
  // Viral clip 6.708–13.0 s (6.29 s): close-up of the lead laughing. Only the lead is in this shot, so swapping the lead replaces the whole face,
  // hence the original is the reference (generated once). The reference is not retimed: a whole 7 s from 6.708 (ends with 0.7 s of the sax shot),
  // and compose takes the first 6.292 s at original speed. A retimed reference clearly hurt lip sync (see README, pending one more test).
  // Without a lead swap, compose uses the original-speed 6.708–13.0 s (151 frames) lead-original-6s.mp4. Prompt only says to replace the person: no outfit, mouth or expression.
  id: 'lead',
  referenceVideo: 'assets/tinydesk/lead-original-7s.mp4',
  referenceAudio: 'assets/tinydesk/lead-7s.mp3',
  slots: ['lead'],
  prompt: (images: Readonly<Record<string, string>>) =>
    `In @video1, replace the lead singer with the person in ${images.lead}, singing along to @audio1. ${KEEP}`,
  parameters: { duration: 7, ...VIDEO },
  maxCost: '0.40',
  target: 6.292,
  fit: 'trim' as const,
  base: 'assets/tinydesk/lead-original-6s.mp4',
  // Output check: if the original lead's face is still in the first 6.292 s used (face similarity ≥ 0.6), treat as not swapped and retry once
  // (tested: missed swaps score 0.87–0.97, swapped people stay under 0.4).
  check: {
    original: 'assets/tinydesk/lead-original-7s.mp4',
    faces: { lead: [0.79, 0.33] as const },
    maxSimilarity: 0.6,
    retries: 1,
  },
};

export default defineModels([
  {
    id: 'tiny-desk',
    name: 'Tiny Desk video',
    kind: 'video',
    upstream: 'yir',
    upstreamModel: 'bytedance/seedance-2.0-mini',
    credits: 10,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    // 4 segments at 1.35 + one lead retry at 0.40 + 5 photo edits at 0.10, each possibly hedged once (another 0.10).
    maxCost: '1.95',
    timeoutMinutes: 25,
    effect: {
      slots: [
        {
          id: 'lead',
          label: 'Lead vocals',
          required: false,
          prep: outfit(
            'a crimson baseball cap with a white script letter A logo and a small white swoosh, and a black hoodie with a crimson ALABAMA chest panel',
          ),
        },
        {
          id: 'sax',
          label: 'Sax',
          required: false,
          prep: outfit(
            'a navy and white color-block hoodie with a small white letter N logo on the chest and black over-ear headphones',
          ),
        },
        {
          id: 'keys',
          label: 'Keys',
          required: false,
          prep: outfit(
            'a black quarter-zip pullover with red trim and red BULLDOGS lettering on the chest, and a black headset with a boom microphone, no hat',
          ),
        },
        {
          id: 'backLeft',
          label: 'Backing vocals (left)',
          required: false,
          prep: outfit(
            'a white quarter-zip pullover with a small burnt-orange longhorn logo on the chest and a black headset with a boom microphone',
          ),
        },
        {
          id: 'backRight',
          label: 'Backing vocals (right)',
          required: false,
          prep: outfit(
            'a red track jacket with black shoulder stripes and a white IU logo on the chest, and a black headset with a boom microphone',
          ),
        },
      ],
      prep: {
        upstreamModel: 'openai/gpt-image-2.5-sunburst',
        parameters: { resolution: '1K', aspect_ratio: '3:4' },
        maxCost: '0.02',
      },
      segments: [
        {
          // 1.375–6.708 s (5.33 s) retimed to 5 s: band wide shot.
          id: 'band1',
          referenceVideo: 'assets/tinydesk/band1-5s.mp4',
          referenceAudio: 'assets/tinydesk/band1-5s.mp3',
          slots: ['keys', 'backLeft', 'backRight'],
          prompt: bandPrompt,
          parameters: { duration: 5, ...VIDEO },
          maxCost: '0.35',
          target: 5.333,
          base: 'assets/tinydesk/band1-original.mp4',
        },
        lead,
        {
          // 13.0–16.375 s (3.375 s) retimed to 4 s: sax solo, keyboardist visible bottom right.
          id: 'sax',
          referenceVideo: 'assets/tinydesk/sax-4s.mp4',
          referenceAudio: 'assets/tinydesk/sax-4s.mp3',
          slots: ['sax', 'keys'],
          prompt: (images) => {
            const swaps = [
              images.sax && `the saxophone player with the person in ${images.sax}`,
              images.keys && `the person in the bottom right corner with the person in ${images.keys}`,
            ].filter(Boolean);
            return `In @video1, replace ${swaps.join('; ')}. They are performing along to @audio1. ${KEEP}`;
          },
          parameters: { duration: 4, ...VIDEO },
          maxCost: '0.30',
          target: 3.375,
          base: 'assets/tinydesk/sax-original.mp4',
        },
        {
          // 16.375–19.06 s (2.69 s) retimed to 4 s: band wide shot outro.
          id: 'band2',
          referenceVideo: 'assets/tinydesk/band2-4s.mp4',
          referenceAudio: 'assets/tinydesk/band2-4s.mp3',
          slots: ['keys', 'backLeft', 'backRight'],
          prompt: bandPrompt,
          parameters: { duration: 4, ...VIDEO },
          maxCost: '0.30',
          target: 2.688,
          base: 'assets/tinydesk/band2-original.mp4',
        },
      ],
      // Final video: original audio of the viral clip 1.375–19.063 s, 720×1280, 24fps.
      compose: {
        audio: 'assets/tinydesk/song.m4a',
        audioStart: 1.375,
        audioDuration: 17.688,
        width: 720,
        height: 1280,
        fps: 24,
      },
    },
  },
]);
