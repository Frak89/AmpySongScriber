# AmpySongScriber Unified – offline Android

Single Android APK that embeds **both** the four-stem audio-separation model and the note-transcription model at build time. Offline functionality does not require accounts, subscriptions, credits, URLs, or a Python server.

## Precisely what the three uploaded projects contribute

- **Songscribe** (Gabriel Serna, MIT): original frontend idea and project baseline; the unified Android target replaces its server-dependent Next.js interface with a minimal music-focused interface.
- **Spleeter** (Deezer, MIT): Python/TensorFlow source reviewed; its ZIP does not include trained weights and cannot be packaged directly into a small Android app. Instead the app uses the **HTDemucs ONNX** four-stem separator (Meta, MIT) with browser-DSP from MIT-licensed [sdemux](https://github.com/joverval/sdemux). It outputs original audio as vocals, drums, bass and other WAV stems.
- **MuseScore Studio** (GPLv3): the native C++/Qt scoring engine is *not* in this APK. The app generates standard MusicXML documents editable in MuseScore; it also generates an offline simple PDF of staff notation.
- **Spotify Basic Pitch** (Apache 2.0): local model for transcribing audio to MIDI, then MusicXML and PDF.

## Features

Import local music -> Demucs 4-stem WAV isolation -> listen to each track -> share/save individual WAV or ZIP -> run offline Basic Pitch on chosen track -> export instrument MIDI, MusicXML and PDF.

Uses Android sharing dialog to let the user choose a save destination. No arbitrary daily time, transcription, or download quota is imposed. RAM/CPU/storage and decoder format compatibility still limit practical audio duration and inference speed. Demucs weights are ~181 MB, so a truly bundled offline APK cannot be very small.

Score engraving is intentionally basic, quantized to a nominal 120 BPM and 4/4; drums, simultaneous notes, musical rests and advanced notation may need editing in MuseScore. AI audio stems are estimates, not lossless originals. Basic Pitch is less effective on percussion and complex mixed sounds. The app has **not yet been performance-tested on physical Android hardware**.

## Build and install

GitHub Actions -> 'Build AmpySongScriber UNIFIED offline APK' -> successful run -> Artifacts -> 'AmpySongScriber-UNIFIED-offline-APK' -> extract app-debug.apk -> install on device.

Main source: unified/index.html, unified/src/main.js, unified/src/demucs-loader.js.

The GitHub Actions build installs packages and fetches the HTDemucs ONNX model at build time. Source model SHA256: e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077.

## Credits and redistribution

Songscribe (MIT, Gabriel Serna), Spleeter (MIT, Deezer), Demucs (MIT, Meta AI), sdemux (MIT, joverval), Basic Pitch (Apache 2.0, Spotify), ONNX Runtime Web (MIT, Microsoft), MuseScore Studio (GPLv3, MuseScore Limited). This distribution does not reuse MuseScore GPLv3 native source code; MusicXML interoperability is a file-format feature, not a copied MuseScore binary.
## Rev5: AmpyQwen local GGUF (experimental)

AmpySongScriber adds an optional **on-device Qwen3-0.6B Q4_K_M assistant**. Tap **Seleziona GGUF da Download** and choose your already-downloaded `Qwen3-0.6B-Q4_K_M.gguf` (~484 MB). Tap **Avvia Qwen**. No GGUF file is shipped inside the APK; no backend or download is required at runtime.

This is a **language model**. It reads the recognized MIDI note metadata, YAMNet classifications and BPM, then offers explanations and correction ideas. It is **not an audio source separator or a pitch detector** and cannot inspect PCM audio by itself. The existing HTDemucs, YAMNet, Basic Pitch, MusicXML and PDF features remain responsible for the actual processing.

Runtime: MIT-licensed `@wllama/wllama` (llama.cpp WebAssembly), bundled locally in the APK. The Qwen assistant supports load, inference and unload. It uses one CPU/WASM thread and a limited context to minimize memory; successful initialization depends on available Android WebView memory/architecture. The system picker must grant access to the GGUF from Downloads. The app automatically unloads Qwen before expensive audio-separation and transcription jobs; the user can load it again afterward. This has not been validated on a physical Pixel 7 Pro.

GGUF access is voluntary, data stays on the device. Qwen suggestions require checking against the real music; never treat guessed instrument labels or notes as authoritative.

## Rev6: Local Qwen answer saving and history

Qwen Rev5 showed text only: there was **no persistent history**, and previous text cannot be reconstructed after the app closes. Rev6 stores each Qwen prompt before generation and its result afterward in local IndexedDB (fallback to localStorage if IndexedDB is restricted). It confirms success or displays a clear storage error. The History section reopens saved analyses; TXT/PDF export uses Android's share/save picker. **JSON backup and import** allow restoring history after uninstalling a debug-signed APK. An exported JSON file must be saved outside the app before uninstalling.

The GGUF in Android Downloads remains outside app storage and is not duplicated: after restart, select the same file again. Saving a model path/name is not a persistent Android Storage Access Framework permission. Qwen does not itself save audio stems or edit note events; it provides textual commentary based on the already computed music data. Use the respective WAV, MIDI, MusicXML and score PDF export buttons for actual music files.

Build checks include `node scripts/test-qwen-history.mjs`. A working Android APK build still does not prove that WebAssembly can run Qwen GGUF within Android WebView memory limits; this needs testing on the physical device.

## Rev7: choose ONE real instrument, then download WAV/MIDI/MusicXML/PDF

The music-first interface no longer requires Qwen or a GGUF. It operates with three dedicated trained neural models:

1. **HTDemucs 6s fp16weights** (Meta / StemSplitio MIT) truly isolates one requested audio source at a time: guitar, piano, bass, drums, or vocals. A sixth residual source exists for material not covered by these five. Its model is approximately 136 MB on disk but may require ~1.1 GB memory at inference and may not run successfully in Android WebView on all devices. Inference is performed in a cancellable Worker.
2. **YAMNet** (Google Apache 2.0) classifies the residual mixture by likely timbre; it does not produce an isolated source for e.g. violin. The UI only labels residual as a **possible** instrument above a confidence threshold, never as a verified isolated violin.
3. **Spotify Basic Pitch** (Apache 2.0) transcribes notes from the *selected isolated source*. A deterministic pitch-range and short-note cleanup is applied based on the instrument type. This improves obvious outliers but cannot guarantee exact notes. Drums are not accurately transcribed by Basic Pitch without a dedicated percussion model.

For each isolated stem the app exposes **Download WAV**, **Download MIDI**, **Download MusicXML**, and **Download PDF**. The last three start a single-instrument transcription if not yet prepared. General score export buttons remain available. Only one WAV stem is held in memory at a time to limit RAM and output size. To isolate another instrument, select it and process the song again.

This replaces the prior 4-source ONNX model. The source is available from:
https://huggingface.co/StemSplitio/htdemucs-6s-onnx

This Android target is not performance-tested on a Pixel 7 Pro. Model memory, long audio, and WebView constraints may still cause failures. No server is used during inference. Qwen files and experiments remain in git history but the Rev7 critical path is entirely music-model based.

## Rev8: two offline GGUF assistants processing 10-second parts (experimental)

Two user-supplied local GGUF models are selected independently with Android's system file picker. Models are used **sequentially** (not simultaneously), via a packaged single-threaded llama.cpp WASM runtime. No GGUF weights are downloaded or bundled at app runtime.

For every 10-second chunk of one real HTDemucs 6s isolated source:

1. Basic Pitch estimates a **draft** of the notes and time positions.
2. GGUF 1 analyzes numerical audio measurements and the **draft**, returns a small JSON interpretation.
3. GGUF 1 is unloaded. GGUF 2 loads and reviews the first model's analysis and proposes **bounded** DSP settings and conservative note-rejection settings. No model is permitted to invent new pitches.
4. GGUF 2 is unloaded. FFT-based spectral suppression is applied to actual mono PCM using the bounded parameters. Basic Pitch estimates pitches **again** on the cleaned chunk; conservative comparisons remove very short or unsupported transient notes.
5. The 10-second cleaned audio is saved as a real mono 22,050 Hz PCM16 WAV named `part001.wav`, `part002.wav`, … in Android app-private persistent Data storage. A manifest is committed only after file-size verification; it also contains the draft notes, final notes and both models' interpretations. These part files are retained on app process restart (but **lost on app uninstall**).
6. A user can pause **after the current block**, resume by selecting the same song and GGUFs, or export a ZIP of WAV parts and individual `partNNN_draft.musicxml` and `partNNN_revised.musicxml` previews.
7. At completion the app merges the PCM payloads in order into one verified standard RIFF/WAVE output without loading every part simultaneously, then compiles merged MIDI, MusicXML and vector PDF scores.

**Important limitations:** GGUF models are text models and **do not directly listen to the song**. Audio decoding and isolation use HTDemucs, pitch detection uses Basic Pitch and cleaning uses numerical DSP; the model inputs are numeric summaries and draft MIDI only. Their suggestions may degrade audio instead of improving it, and the note score can still have mistakes. Loading and unloading two GGUF models **for each chunk** can be extremely slow on mobile devices, even if the process remains responsive. Processing **stops** when the app is terminated or Android kills the process; no background execution is promised. App-private parts persist across process restarts but not uninstall. Export parts to external storage before uninstalling debug APKs. Physical Pixel 7 Pro GGUF inference is not verified.

CI regressions include FFT filtering, JSON/bounds and merging `part001.wav` plus `part002.wav`.
