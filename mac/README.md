# Sotto for Mac

Hold a key, speak, release: the text appears at your cursor, in any Mac app. Everything runs on this Mac.
Speech recognition and cleanup both use [LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B) on the GPU
through MLX (Metal). No audio or text leaves the machine; once the weights are cached the engine runs with the
network switched off.

On an M3 Max, 10 seconds of speech is transcribed and cleaned up in about 0.75 s (0.35 s recognition, 0.4 s cleanup),
and a 58-second dictation in 3.4 s. The model uses about 2.6 GB of memory.

## Set up

From this folder (`mac/`):

```sh
scripts/setup-engine.sh      # Python environment with MLX + the model weights (2.3 GB, once)
scripts/build-app.sh --install   # builds dist/Sotto.app, copies it to /Applications and starts it
```

Requires an Apple Silicon Mac, macOS 14 or later, Xcode command-line tools, and Python 3.12 (or `uv`).

On first launch the Setup tab asks for two permissions:

- **Microphone**, to hear you.
- **Accessibility**, to notice the dictation key in any app and paste at the cursor.

macOS ties both grants to the app's signature. An ad hoc signature changes with every build, and afterwards the
switch in System Settings still looks on while the app is refused. To keep the grants across rebuilds, give the
app a fixed signature once:

```sh
scripts/make-signing-identity.sh     # a self-signed certificate in its own keychain file
security list-keychains -d user -s ~/Library/Keychains/login.keychain-db \
    "$HOME/Library/Application Support/Sotto/signing.keychain-db"
```

`build-app.sh` then signs with it by itself (or with `SOTTO_SIGN_IDENTITY`, if you set one). Whenever the
signature does change, `--install` clears the stale grants so they can be given again.

Sotto shows in the Dock and in the menu bar; the Dock icon can be turned off in Settings → General.

The dictation key is fn. Settings → General can switch on Right Option, Right Command and Right Control as well, or
instead: any key that is ticked starts dictation, which lets an external keyboard without a Mac fn key (or one of
its macro keys, remapped to Right Command) work alongside the built-in one. While fn is in use, set **System
Settings → Keyboard → Press 🌐 key to → Do Nothing**, otherwise a tap also opens the emoji picker.

**Microphone.** Settings → General → Microphone picks which input Sotto records from, by name;
"System default" follows macOS. A chosen microphone that is unplugged falls back to the system's
until it returns.

**An API instead of the local model.** Settings → General → Speech engine → *An OpenAI-compatible
API* sends each recording to `{API address}/audio/transcriptions` at a service of your choice
(OpenAI, Groq, a server of your own), and frees the memory the local model held. Fill in the
address, the key if the service wants one, and the transcription model's name; an optional
editing model does the Smart pass through `/chat/completions`. The key is kept in the Mac's
keychain, which Sotto does not touch at all unless the API is selected.

## Use

| | |
|---|---|
| Hold the key, speak, release | Dictate (push to talk) |
| Tap the key twice quickly | Hands-free: keeps listening until you tap once more |
| Esc | Cancel, while recording or while the text is being prepared |

A pill at the bottom of the screen shows the waveform while it listens and dots while it works.
For that time the Mac and its display are kept awake, so a long hands-free dictation is not cut
short by sleep.

Settings (menu bar icon → Settings…):

- **Editing**: *Verbatim* (what was heard), *Light* (drops um/uh and stutters), *Smart* (a second pass with the same
  model: applies self-corrections such as "at five, actually six", fixes punctuation, formats spoken lists and
  "new line"). Smart is English only.
- **Style**: Formal, Casual or Very casual, as a default and per app. Tone only changes capitalization and the final
  period.
- **Dictionary**: words to spell exactly, and "always replace X with Y" pairs for words the model mishears.
- **Snippets**: say a phrase, get saved text ("my address").
- **History**: the last 500 dictations, kept in a local file; can be switched off.

## How it works

```
fn key ──▶ event tap ──▶ TriggerMachine ──▶ AVAudioEngine (16 kHz mono)
                                                  │ speech gate: silence never reaches the model
                                                  ▼
                               engine/server.py (Python, MLX on Metal, model stays loaded)
                                  1. "Perform ASR in English."      audio ─▶ transcript
                                  2. few-shot cleanup prompt        transcript ─▶ clean text
                                     guard: a result that grew, lost a question mark or
                                     gained new words is discarded for the transcript
                                                  ▼
            PostProcessor: replacements, fillers, snippets, tone, fit to the text before the cursor
                                                  ▼
                 clipboard paste (⌘V), then the previous clipboard is put back
```

- `Sources/SottoCore` holds the logic with no UI dependencies, covered by `swift test`: the key state machine, the
  speech gate and the text post-processing.
- `Sources/Sotto` is the menu-bar app: event tap, recorder, engine bridge, paste, pill and settings.
  `CloudEngine.swift` is the API route; its requests are built and parsed in `SottoCore/CloudAPI.swift`.
- `engine/server.py` is the sidecar. The app talks to it over stdin/stdout: one JSON line per request followed by
  raw float32 samples, JSON lines back. Its log is `~/Library/Logs/Sotto/engine.log`.
- Settings and history are JSON files in `~/Library/Application Support/Sotto/`.

## Checking it without the UI

```sh
swift test
swift build
.build/debug/Sotto --transcribe clip.wav [--cleanup smart|light|verbatim] [--language English] [--model ID]
.build/debug/Sotto --mic-check 3 [--microphone NAME]   # runs the live capture path, prints loudness statistics only
.build/debug/Sotto --list-microphones
.build/debug/Sotto --transcribe clip.wav --api http://127.0.0.1:47631/v1 --api-model whisper-1   # through an API (key: SOTTO_API_KEY)
python3 ../testdata/stand_in_api.py 47631   # a stand-in API that checks what it is sent
.build/debug/Sotto --keychain-check       # stores, reads and removes a throwaway keychain item
.build/debug/Sotto --snapshot /tmp/shots  # draws the settings tabs and pill states to PNG files
engine/.venv/bin/python engine/tune_cleanup.py   # cleanup prompt against hard cases (needs engine/.venv)
../testdata/make.sh                       # spoken test clips, made with the Mac's own voice
```

## Limits

- Text arrives when you stop speaking, not while you speak. The model has a live mode, but only in its PyTorch
  build, not in MLX.
- Smart cleanup is a 2-billion-parameter model following examples. It is good at fillers, self-corrections and
  lists, and its mistakes are caught only when they change the text a lot.
- Recordings stop at 5 minutes.
- The model's license is the LFM Open License v1.0, which is not an OSI license; read it before any commercial use.

## The other Sottos

The same idea for [Windows](../windows), [Android](../android) and [the browser](../web). The
[main README](../README.md) has the overview.
