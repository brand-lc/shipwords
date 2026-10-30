# Music generation jobs

Status: in progress. Fold into `docs/architecture.md` §6 once a music site is live.

Today `packages/jobs` only knows image and video jobs; audio appears only as a reference track for effects and in compose. A music site (style prompt plus lyrics in, songs out) needs a third job kind. Yir already serves music behind `submitMusic` (`POST /v1/music/generations`) in `@yir-ai/sdk` 0.12.0, so no SDK upgrade is needed.

## Interface changes

- `ModelDefinition.kind` and `PublicModel.kind` gain `'music'`. Music models take no references (`maxReferences: 0`) and no `effect`; `defineModels` rejects either.
- `POST /api/jobs` takes an optional `lyrics` string (at most 3,000 characters) for music models. Other kinds ignore it. `GenerateInput` in `react.ts` gains `lyrics`.
- `SubmitInput.kind` gains `'music'` and `SubmitInput.lyrics` is new; `JobPart.lyrics` carries it from `input_json` to the adapter.
- `YirAdapter.submit` sends music through `submitMusic` with `input: { type: 'text', prompt, lyrics? }`, `parameters` and `max_cost`.

## Lyrics source

Yir requires exactly one lyrics source for vocal music: `input.lyrics`, `parameters.lyrics_optimizer` (the model writes lyrics from the prompt) or `parameters.instrumental`. The engine settles it once at job creation, so the stored input is always valid:

1. lyrics given: `instrumental` and `lyrics_optimizer` are dropped;
2. else `instrumental: true`: `lyrics_optimizer` is dropped;
3. else `lyrics_optimizer: true` is set.

A site lists `instrumental` in `allowedParameters` to offer instrumentals; it never needs to pass `lyrics_optimizer` itself.

## What does not change

- Storage: `input_json` holds `{ references: [], parameters, lyrics? }` and the `prompt` column holds the style prompt. `jobs.kind` is a plain text column, so there is no migration.
- Money: one charge per job however many tracks the model returns (Suno returns two). Charging, refunds, guest quota, one-way states, cancel and cost recording run the same code as image jobs.
- Outputs: each track is stored as `jobs/<jobId>/<n>.<ext>`; `audio/mpeg` maps to `.mp3`.
- Mock upstream: music jobs return the site's `public/mock-output.mp3`.
- Finish email says "song" for music jobs.

## Models measured (2026-10-29, Japanese lyrics)

| Model               | Price                   | Output                   | Latency    | Note                              |
| ------------------- | ----------------------- | ------------------------ | ---------- | --------------------------------- |
| `suno/suno-v6`      | about $0.05 per request | 2 tracks (79 s and 50 s) | about 48 s | Unofficial channel; may disappear |
| `minimax/music-2.6` | about $0.16 per track   | 1 track (66 s)           | about 62 s | Official; the fallback            |

Both declare `instrumental` and `lyrics_optimizer` in their contracts.
