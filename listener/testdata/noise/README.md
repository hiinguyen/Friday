# Noise test clips

Background noise that must never start or prolong a voice command, for `test_command.py` and `test_vad.py`.
WebRTC VAD classified 84-100% of these frames as speech; that is why commands used to run to the 15 s cap.

| File | What | Source | Length |
| --- | --- | --- | --- |
| `fan.flac` | A desk fan in the owner's room, about -28 dBFS, no voice | Recorded by Friday's microphone after a wake word | 6.0 s |
| `typing.flac` | Fast typing on a computer keyboard | Wikimedia Commons, `File:Typing fast.ogg` by stephan, public domain | 6.0 s, from 2.0 s |

Both are 16 kHz mono FLAC.
