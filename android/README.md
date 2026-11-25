# Sotto for Android

A voice keyboard. Tap the microphone in any app, speak, and the text is typed where the cursor
is. Speech is recognized on the phone by LFM3-Audio-2B through
[LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), on the GPU when the phone's GPU can
load the model and on the CPU otherwise. After the one-time model download, the app makes no
network requests.

It is the phone counterpart of the [Mac app](../mac) and shares its behaviour:
the same cleanup prompt, the same filler removal, tones, dictionary, replacements and snippets.

## Install

```sh
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 17 for the build and the Android SDK with platform 37 (set `sdk.dir` in
`local.properties`, or `ANDROID_HOME`). A ready-made APK is attached to the
[releases](https://github.com/aluferraz/sotto/releases). Then open **Sotto** on the phone and follow the four steps on the Setup tab:

1. **Download the speech model** (1.5 GB, from Hugging Face; it can be paused and continued).
2. **Allow the microphone.**
3. **Turn on the Sotto keyboard** in Android's keyboard settings.
4. **Switch to it.**

The phone needs Android 10 or newer, an arm64 processor, about 2 GB of free storage and, in
practice, 8 GB of memory or more: the loaded model holds 1 to 3 GB.

## Using it

- **Tap** the microphone to start, tap again to finish. Or **hold** it while you talk.
- **✕** discards the recording, or the transcription in progress.
- **ABC** opens a plain letter keyboard for small corrections; its microphone key starts a
  dictation. **?123** has digits and punctuation. The globe switches to your other keyboard.
- The strip at the top shows the state, the words as they are recognized, and anything that
  needs attention (tap it to open the app).

Settings in the app: language (18, or automatic), editing level (Verbatim, Light, Smart), tone
(Formal, Casual, Very casual, with Casual applied in chat apps), GPU on or off, how long the
model stays in memory, and the dictionary, replacements and snippets.

**An API instead of the phone's own model.** Settings → Speech engine → *Use an OpenAI-compatible
API* sends each recording to `{API address}/audio/transcriptions` at a service of your choice,
and needs no model download. Enter the address, the key if the service wants one, and the
transcription model's name; an optional editing model does the Smart pass. The key is stored
encrypted with a key in the Android Keystore, which is only created once you save one. Plain
`http://` addresses are allowed, for a server on your own network. History stays on the
phone, and password fields are never recorded in it.

## How it is built

| Module | What it is |
|---|---|
| `core` | Plain Kotlin, no Android: text post-processing, the speech gate, the cleanup prompt and its guard, WAV helpers, and `SpeechEngine`, the wrapper around LiteRT-LM. Unit tests live here. |
| `app` | The Android app: `SottoIme` (the keyboard service), `KeyboardView` (one canvas-drawn view), `Recorder`, `EngineHost` (loads and unloads the model, one worker thread), `ModelStore` (download and checksum) and the Compose settings screens. |
| `bench` | A desktop command that runs `SpeechEngine` on this computer against the same model file, for tuning prompts without a phone. |

Things worth knowing:

- **Audio longer than 28 s** is cut at the quietest point near each boundary and transcribed
  piece by piece, because the phone build of the model reads audio in 30 s windows and has a
  2,048-token context. Long transcripts are cleaned in pieces of at most 90 words: they fit the
  context, and the model drops fewer sentences from short pieces.
- **Silence never reaches the model.** A recording without speech is dropped by the speech gate;
  the model would otherwise invent a sentence.
- **The cleanup guard** discards the second pass's answer when it looks like an answer to the
  transcript instead of a cleaned copy (the 4-bit model does this for questions and commands),
  or when a long piece came back noticeably shorter, and types the raw transcript.
- **The cleanup conversation is prepared ahead.** After loading and after each dictation, while
  nobody is waiting, the model reads the cleanup instructions and examples for the next one, so
  cleaning costs only the transcript. Each prepared conversation is used once:
  `Conversation.clone()` would be the obvious shortcut, but its copies gave answers that
  drifted from request to request with this model (`bench --repeat` shows it).
- **GPU loading can fail in two ways.** An error falls back to the CPU at once. A crash of the
  whole app is remembered through a marker file, and the next start uses the CPU and says so on
  the Setup tab.
- **LiteRT-LM 0.20.0 or newer is required.** Earlier versions carry state from one conversation
  into the next with this model.

## Testing

```sh
./gradlew :core:test                      # 36 unit tests

# The engine code on this computer (needs the model file; Gradle fetches a JDK 25 for it):
./gradlew :bench:installDist
bench/build/install/bench/bin/bench MODEL.litertlm ../testdata/a.wav
bench/build/install/bench/bin/bench MODEL.litertlm --cleanup
bench/build/install/bench/bin/bench MODEL.litertlm --repeat --prepare ../testdata/c.wav
```

Debug builds accept a WAV file in place of the microphone, which is how the keyboard is tested
on an emulator (an emulator's microphone is silent, and its GPU cannot load the model, so it
runs on the CPU):

```sh
adb push clip.wav /data/local/tmp/ && adb shell run-as dev.sotto.keyboard cp /data/local/tmp/clip.wav files/
adb shell am broadcast -a dev.sotto.keyboard.DEBUG_DICTATE --es path clip.wav
```

With the keyboard open, the result is typed into the focused field; otherwise it is logged
under the tag `Sotto`.

The API route can be tested the same way against `../testdata/stand_in_api.py` running on the
computer (an emulator reaches it at `10.0.2.2`):

```sh
python3 ../testdata/stand_in_api.py 47631
adb shell am broadcast -a dev.sotto.keyboard.DEBUG_API --es url http://10.0.2.2:47631/v1 --es model whisper-1 --es key test
adb shell am broadcast -a dev.sotto.keyboard.DEBUG_DICTATE --es path clip.wav
adb shell am broadcast -a dev.sotto.keyboard.DEBUG_API --ez off true      # back to the phone's own model
```

## What it has run on

- Emulators with Android 14 and 16, on the CPU: setup, download with pause and resume, dictation
  of test clips into its own field and into Android's Settings search, the typing layout, dark
  mode and landscape.
- A Galaxy S25 Ultra with Android 17, on the GPU. The first load took 91 s while the model was
  compiled for the GPU; the first clip (9 s of speech) took 4.8 s to recognize and 6.2 s to clean.
  Later loads and clips were not timed.
- The API route and the encrypted key, on an Android 14 emulator against the stand-in server:
  upload accepted, key sent, key still readable after the app was restarted.
- Not tried: Android 10 to 13, and TalkBack (the keyboard's keys have no spoken labels yet).

## Licence of the model

LFM3-Audio-2B is under the LFM Open License v1.0, which is not a standard open-source licence
and restricts commercial use by organizations above a revenue threshold. Read it before
distributing an app that downloads the model.
