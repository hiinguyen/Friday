# Speaker test clips

Short clips of three real speakers for `test_speaker.py`.
Synthetic espeak-ng voices cannot be used: they share one vocal tract model, so the speaker model scores them all as the same person.

| Files | LibriSpeech speaker | Source utterances | Length |
| --- | --- | --- | --- |
| `a-enroll-1..4.flac` | 777 (enrolled speaker) | 777-126732-0000 to 0003 | 3.0 s each, from 0.5 s |
| `a-test-1..2.flac` | 777 | 777-126732-0008, 0009 | 2.5 s each, from 0.5 s |
| `b-test-1..2.flac` | 2803 (another man) | 2803-154320-0000, 0001 | 2.5 s each, from 0.5 s |
| `c-test-1..2.flac` | 5895 (a woman) | 5895-34615-0000, 0001 | 2.5 s each, from 0.5 s |

Source: Mini LibriSpeech `dev-clean-2` (OpenSLR resource 31), derived from LibriSpeech by Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur.
License: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
Changes: trimmed as listed above and resampled to 16 kHz mono FLAC.
