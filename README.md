# echoscribe

Turn a recording into a note you can actually use — summary, action items, decisions, and a timestamped transcript. Entirely on your own machine, with Tether's [QVAC SDK](https://qvac.tether.io).

```
$ npm run note -- samples/standup.m4a

Summary
The team is planning to run the migration script against the production replica...

Action items
  - Update the status page to reflect the new maintenance window. (0:25)
  - Write the rollback procedure before Friday. (0:37)
  - Resize the staging database to the new instance size. (0:44)

Decisions
  - We decided to move the migration to Saturday night instead of Thursday. (0:21)
  - We are not going to start the migration until the rollback procedure is reviewed. (0:37)
```

Every action item carries the moment in the recording it came from, so you can go back and hear the context.

## Why

Meeting notes and voice memos are the most sensitive audio most people produce — salaries, health, half-formed ideas, other people's names. Sending them to a transcription service means handing all of that to somebody else's server.

- **Private.** The audio and the transcript never leave the machine. Both models run locally.
- **No API key, no bill.** Nothing to sign up for, and no per-minute charge.
- **Works offline.** The weights download once, then you can run it with the network off.

## Requirements

- **Node.js** >= 22.17 (`node -v`)
- **A platform QVAC supports.** Built and tested on macOS 15.6 on an M4. See the [QVAC system requirements](https://docs.qvac.tether.io/system-requirements/) for Linux and Windows.
- **About 5 GB of free disk.** `npm install` writes ~4.1 GB into `node_modules`, because the SDK ships native inference engines for every modality it supports. The two model files add ~855 MB, cached once under `~/.qvac`.

## Install

```bash
git clone https://github.com/adibbabrar/echoscribe.git
cd echoscribe
npm install
```

## Run

**Check your setup** — loads both models and generates one sentence locally. Worth doing first, because it fails fast if something is wrong:

```bash
npm run check
```

**Write a note from one recording:**

```bash
npm run note -- samples/standup.m4a
```

**Or process a whole folder at once**, loading the models a single time:

```bash
npm run batch -- ./recordings
```

Notes are written to `notes/` as Markdown. `batch` skips any recording that already has a note, so an interrupted run can be resumed by running it again.

**Using your own audio.** Any `.mp3`, `.m4a`, `.ogg`, `.wav`, `.flac` or `.aac` file works. Voice Memos on macOS and iOS exports `.m4a` directly, so its recordings can be passed straight in.

**The first run downloads ~855 MB** of model weights. That happens once; every run after it is offline.

Two sample recordings are committed so you can try it immediately. `npm run samples` regenerates them with macOS's `say` command if you want to change what they say.

## QVAC SDK version

This project uses **`@qvac/sdk` 0.19.1**, declared as a regular dependency:

```json
"dependencies": {
  "@qvac/sdk": "^0.19.1"
}
```

Confirmed against the installed package:

```bash
$ node -p "require('./node_modules/@qvac/sdk/package.json').version"
0.19.1
```

## QVAC functions used

| Function | Used in | What it does here |
|---|---|---|
| `loadModel` | `src/models.js` | Loads the speech and language models, reporting download progress. |
| `transcribe` | `src/transcribe.js` | Speech to text. Called with `metadata: true`, which returns timestamped segments instead of one joined string — that is what makes every line in the note traceable back to a moment in the audio. |
| `completion` | `src/extract.js`, `src/check.js` | Writes the summary and pulls out the action items and decisions. |
| `unloadModel` | `src/memo.js`, `src/batch.js`, `src/check.js` | Frees a model's memory when the command finishes. |
| `getSystemResources` | `src/check.js` | Reports the machine the smoke test is running on. |
| `close` | `src/memo.js`, `src/batch.js`, `src/check.js` | Shuts down the SDK's background worker so the process can exit. |
| `SUPPORTED_AUDIO_FORMATS` | `src/transcribe.js` | The formats the SDK's decoder accepts, used to reject a file before spending 30 seconds loading a model for it. |

## Models

Both are QVAC model constants, and both run on-device:

| Model | Constant | Size | Role |
|---|---|---|---|
| Whisper base, q8_0 | `WHISPER_BASE_Q8_0` | 82 MB | Speech to timestamped text. |
| Llama 3.2 1B Instruct, Q4_0 | `LLAMA_3_2_1B_INST_Q4_0` | 773 MB | Writes the note from the transcript. |

The **multilingual** Whisper build, not one of the English-only ones: the English-only models mangle non-English names, which personal recordings are full of.

## How it works

1. **Transcribe.** `transcribe({ metadata: true })` returns segments of `{ text, startMs, endMs }`. Whisper emits these as it decodes, so they arrive clipped mid-phrase and sometimes flagged to mean "this continues the previous one"; `src/segments.js` merges them into readable utterances.
2. **Extract.** Three separate calls to `completion` — one for the summary, one for action items, one for decisions.
3. **Locate.** Each extracted line is matched back against the transcript by word overlap to find the moment it came from.
4. **Render.** The pieces become a Markdown note in `notes/`.

## Design notes

Everything below was measured against the two sample recordings, not guessed.

**Three narrow prompts, not one asking for JSON.** A 1B model asked for structured output spends its attention on getting the brackets right and produces worse content inside them, and one malformed brace loses the entire response. Three plain-text prompts each parse independently, and a bad result in one still leaves the other two usable.

**Timestamps are found in code, not asked of the model.** The obvious design is to number the transcript and ask the model to cite a line. It does that badly — inventing indices, reusing one for everything, quietly giving up part-way down a list — and a confidently wrong timestamp is worse than none, because it sends you to the wrong part of the recording. So `src/align.js` finds each line by matching its meaningful words against the transcript instead. It is deterministic, costs no tokens, and reports nothing when it is unsure. Below **0.34** overlap the best match was coincidence rather than the real source, so that is the cut.

**Ties go to the narrower match, then to the strongest utterance inside it.** A line is matched against runs of up to three consecutive utterances, so a sentence split across two of them still matches. But a wide window holds every word a shorter one does plus extras, so it ties or wins on overlap despite being less precise — which put every timestamp a few seconds early. Two rules fix it: equal scores go to the narrower window, and the reported time is that of the highest-scoring single utterance inside the winning window. Against the standup sample, all seven extracted lines now resolve to the exact utterance that produced them.

**Restatements are removed by similarity, not by string equality.** Greedy decoding makes a model that has run out of material paraphrase its own last answer rather than stop — on one prompt the standup sample produced the same action item twelve times over, each phrased slightly differently. Exact-match deduplication never catches that. Measured on the samples, genuine restatements of one task overlapped 0.80–1.00 while the closest pair of genuinely *different* tasks scored 0.33; nothing real fell between 0.4 and 0.8, so the threshold sits at **0.75** in that empty band.

**Negated lines are never treated as duplicates.** "We are not going to include the distributed case" and "We decided to include the distributed case" differ by one word and score 0.75 — over the threshold. Deduplication would silently drop one of a contradictory pair, and nothing guarantees it drops the wrong one. Showing both is uglier and more honest.

**Action items win over decisions.** A task and the decision to do it get described in nearly the same words, so the same line often comes back from both prompts. A task filed under Decisions is wrong twice over; a decision filed under Action items is at worst redundant.

**`temp: 0`.** Greedy decoding, so the same recording gives the same note every time. At the engine default, prompt changes cannot be evaluated because two runs of the same prompt already disagree.

**Long recordings are folded down in two stages.** Past ~9000 characters of transcript, the recording is summarised chunk by chunk and those summaries are summarised together, which keeps a long lecture inside an 8192-token context. Lists are *not* folded that way — a second pass over action items merges unrelated ones and drops the terse ones — so they are extracted per chunk and deduplicated at the end.

## Limitations

A 1B model running on a laptop is not a large hosted one, and the honest failure modes are:

- **Negation is sometimes dropped.** On the voice-memo sample, "I am not going to include the distributed case" comes back as a decision *to* include it. The contradiction is left visible rather than hidden, but it is a real error.
- **Unusual proper nouns get mangled** by the speech model — "cache invalidation" becomes "cash and validation" on the sample. A larger Whisper build (`WHISPER_SMALL_Q8_0`) fixes most of these at roughly 3× the download.
- **The line between an action and a decision is fuzzy**, and occasionally a real decision lands in the action list.
- **Speakers are not separated.** Whisper returns one stream of text, so a conversation between several people reads as a monologue.

## Project structure

```
echoscribe/
├── src/
│   ├── models.js      Model constants and a loader with a progress line
│   ├── transcribe.js  Audio to timestamped utterances
│   ├── segments.js    Merging, formatting and chunking utterances
│   ├── extract.js     The three prompts, plus map-reduce for long recordings
│   ├── align.js       Finding where in the recording a line came from
│   ├── note.js        Markdown rendering
│   ├── memo.js        One recording (npm run note)
│   ├── batch.js       A folder of recordings (npm run batch)
│   └── check.js       Setup smoke test (npm run check)
├── scripts/
│   └── make-samples.js  Regenerates the samples with macOS `say`
├── samples/           Two committed sample recordings
├── notes/             Output; notes/standup.md is a committed example
└── qvac.config.json   SDK logging configuration
```

## License

[MIT](LICENSE)
