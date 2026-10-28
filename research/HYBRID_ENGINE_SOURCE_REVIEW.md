# AmpySongScriber — Hybrid Engine Rev15: audited sources
Date: 2026-10-28. Target: offline Android Pixel 7 Pro.

## Provenance
Reviewed GitHub repository metadata and project READMEs via connected GitHub. Inspected user Library archive MusIA_Rev9_Full_Termux.zip and MusIA_Rev9_Esempio_Completo.zip. The archive contains Python composition/MIDI/MusicXML modules and a sample five-instrument score; it does NOT contain a pretrained commercial-quality music transcription network. GitHub source repos were accessed remotely via the connector; external git clone was unavailable from build container.

## Comparison
| Source | Useful property | Licence / practical constraint | Included in Rev15 |
| --- | --- | --- | --- |
| nhfruchter/music-transcription | Modular pitch detector / notation and tuner | MIT; old Python/Tkinter | Modular separation of audio and symbolic logic, original JS |
| hanjuTsai/MusicTranscription | Source separation then transcription and score | No explicit licence in GitHub metadata; Python/server | Pipeline reference only, no code imported |
| Omnizart (Music-and-Culture-Technology-Lab) | Separate piano, polyphonic music, vocal, chord, beat, drums tasks | MIT; Python/TensorFlow heavy checkpoints | Instrument-aware task architecture, not Python model ports |
| AudiTranscribe/AudiTranscribe | Spectrogram-assisted transcription UI | GPL-3.0, archived Java desktop | Original spectral evidence, no GPL copying |
| chrisdonahue/sheetsage | Lead sheet melody/chord and tempo/downbeat hints | Code MIT; model weights CC BY-NC-SA 3.0; ~4GB container | Original harmonic timeline, no restricted weights |
| SarahCurtit/songscribe | Offline chord/lyrics → ChordPro | MIT; Python madmom/Cython & ASR | Original chords → ChordPro export, not lyric recognition |
| BreezeWhite/Music-Transcription-with-Semantic-Segmentation | Multi-pitch piano-roll segmentation | GPL-3.0; GPU/TensorFlow and checkpoints | Research only, no GPL code |
| Samarth-Rao/Song-transcriber | Cross compare pitch estimators, confidence, Bb/Eb transposition | AGPL-3.0; heavy Python models | Independently written pitch fusion and transposition |
| EtanHey/songscript | Vocal separation/lyric alignment/transliteration/loop | Apache-2.0; Convex/backend and Python WhisperX | Future reference, no cloud dependence bundled |
| MichaelAshton/piano_transcription | Chord-to-MIDI workflow | MIT; WIP, desktop dependencies | Chord timeline and symbolic export design |
| klang.io | Instrument-specific experiences, Guitar TAB, score editor | Proprietary service | UX reference only, no models or code copied |
| Lunaverus AnthemScore | Note editing, beat tools, sheet export | Proprietary desktop app | UX benchmark only, no models or code copied |
| GitHub music-transcription topic | Search/discovery page | Not one importable engine | Discovery only |
| User ZIP MusIA Rev9 Full Termux | 2..12/4 or /8 quantization, MIDI SMF1, PDF, MusicXML, role profiles | User-held Python composition tool, not audio transcription | Separated symbolic output + rhythm-grid architecture |
| User ZIP MusIA Rev9 Example | Five independent PDF / MIDI / MusicXML parts | Example material rather than algorithm | Individual-export structure reference |

## Actual Rev15 hybrid implementation
Offline neural estimator Spotify Basic Pitch, independent DSP FFT harmonic salience, confidence fusion and octave disagreement evidence; bass/voice monophonic, other instruments polyphonic. Three modes Neural / Hybrid / Spectral; concert C / Bb / Eb transposition, original estimated chord timeline and ChordPro export. Uses current HTDemucs4/6, YAMNet, WAV checks, MusicXML, PDF. Hybrid DSP can operate without GGUF language model. Reports are tagged with estimated metrics.

## What was NOT integrated
Omnizart TensorFlow checkpoints, SheetSage pretrained weights (noncommercial restrictions), copyrighted proprietary Klangio/AnthemScore models, desktop Python applications, true multi-instrument dedicated drum/piano neural models, lyric recognition. The app must not pretend these engines were imported. No automatic model performance claim until measured on device.

## Validation
Synthetic FFT A2 bass 110 Hz; neural/spectral modes; mixture harmony C–Am; transposition; WAV integrity. Pixel 7 Pro on-device tests remain necessary, particularly for real recorded stems and sheet accuracy.

Sources: https://github.com/topics/music-transcription ; https://github.com/nhfruchter/music-transcription ; https://github.com/hanjuTsai/MusicTranscription ; https://github.com/Music-and-Culture-Technology-Lab/omnizart ; https://github.com/AudiTranscribe/AudiTranscribe ; https://github.com/chrisdonahue/sheetsage ; https://github.com/SarahCurtit/songscribe ; https://github.com/BreezeWhite/Music-Transcription-with-Semantic-Segmentation ; https://github.com/Samarth-Rao/Song-transcriber ; https://github.com/EtanHey/songscript ; https://github.com/MichaelAshton/piano_transcription ; https://klang.io/it/ ; https://lunaverus.com/
