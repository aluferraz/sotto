# Sotto in the browser

A dictation pad that runs the speech model on your own graphics card, inside a browser tab:
**<https://aluferraz.github.io/sotto/>**

Hold **Right Ctrl** (or tap the microphone), speak, and the words land in the text box, cleaned
up. The page downloads the model once (1.9 GB) and keeps it in the browser's storage for this
site. After that, no audio leaves the computer.

This folder is also the whole interface and engine of the [Windows app](../windows), which wraps
it in a window and adds a system-wide key and pasting into other apps.

## What it needs

- A browser with WebGPU: Chrome or Edge 113 or newer on a computer, and other browsers as they
  catch up. The graphics card must support 16-bit floats in shaders (`shader-f16`), which
  integrated and discrete cards of the last several years do.
- About 2 GB of free disk space and 2 GB of graphics memory.

The browser version only runs the model itself. The option to use an OpenAI-compatible API
instead belongs to the [Windows](../windows), [Mac](../mac) and [Android](../android) apps.

## How it works

```
microphone ─▶ AudioWorklet (16 kHz mono) ─▶ speech gate: silence never reaches the model
                                                  ▼
                              engine worker (src/engine)
                                log-mel features (mel.ts)
                                audio encoder  ─┐  ONNX Runtime Web
                                language model ─┘  on WebGPU (lfm.ts)
                                  1. "Perform ASR in English."   audio ─▶ transcript
                                  2. few-shot cleanup prompt     transcript ─▶ clean text
                                                  ▼
                 guard: an answer that grew, lost a question mark or gained words is discarded
                                                  ▼
                 replacements, fillers, snippets, tone, fit to the text before the cursor
```

| Folder | What is in it |
|---|---|
| `src/core` | Pure logic, shared rule for rule with the Mac and Android apps: text post-processing, the speech gate, the cleanup prompt and its guard, the key state machine, settings. |
| `src/engine` | The model: feature extraction, the two ONNX graphs with their caches kept on the GPU, the download into the browser's file system with checksums, the worker they live in, and the OpenAI-compatible client that the Windows app uses. |
| `src/app` | The interface (Preact): dictation flow, recorder, the four screens, and the bridge the Windows app plugs into. |

Things worth knowing:

- **The model is [LFM3-Audio-2B-ONNX](https://huggingface.co/LiquidAI/LFM3-Audio-2B-ONNX)** at a
  fixed revision: the 4-bit decoder with 16-bit activations and the float audio encoder, which is
  the pairing its authors give for WebGPU. Every file is checked against its SHA-256 after download.
- **The cleanup instructions are read once.** The decoder's caches after the instructions and
  examples are kept on the GPU, and every cleanup continues from them, so it only pays for its
  own transcript.
- **Audio longer than 28 s** is cut at the quietest point near each boundary and transcribed piece
  by piece; long transcripts are cleaned in pieces of at most 90 words.
- **The model leaves memory** after 15 minutes without dictation (configurable) and loads again,
  in a few seconds, when the key is next pressed.

## Working on it

```sh
npm install
npm run dev        # the page at http://localhost:5173
npm test           # 45 unit tests, including the feature extraction against reference values
npm run build      # type-check and build into dist/
```

`?demo` in the address shows made-up content and touches no stored data (`?demo&theme=dark&tab=settings`);
the screenshots are made that way. `?model=URL/` loads the model files from another place.

The engine itself can only be tested where there is WebGPU, so those tests run the built page in
a hidden Chromium window (Electron, installed in `../windows`):

```sh
E=../windows/node_modules/.bin/electron
$E test/run-engine.cjs MODEL_DIR clip.wav            # transcribe and clean clips, print timings
$E test/run-engine.cjs MODEL_DIR --cleanup           # the cleanup pass over hard cases
$E test/run-app.cjs --e2e MODEL_DIR clip.wav         # the whole page: download, load, speak through a fake microphone, pick microphones
$E test/run-app.cjs --shots DIR                      # screenshots of every screen
```

`MODEL_DIR` is a folder with the five model files named in `src/engine/modelStore.ts`; clips are
16-bit WAV files (`../testdata/make.sh` makes some on a Mac).

## What it has run on

Chromium 156 on an M3 Max (Apple GPU): 10 s of speech is recognized in about 1 s and cleaned in
0.6 s; a 58 s dictation takes 4.9 s plus 4.1 s. Loading takes 2 to 3 s once the files are on disk.
It has not been timed on other graphics cards yet.
