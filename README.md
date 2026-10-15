# F.R.I.D.A.Y.

Always-on voice wake word for Linux (Hyprland/Wayland).
Say "Friday" and an Iron Man style HUD takes over the focused monitor.
Keep talking and the command is transcribed onto the HUD.
Once you enroll your voice, commands from anyone else are ignored.

## How it works

```
mic -> pw-record -> listener/wake.py (Vosk, offline) --JSON lines--> app/src (Electron main) --IPC--> app/renderer (HUD)
                          |
                          +-> listener/command.py (voice check, OpenAI speech-to-text)
                                    +-> listener/vad.py (Silero VAD, offline)
                                    +-> listener/speaker.py (WeSpeaker voiceprint, offline)

agent reply -> app/src (Electron main) --JSON lines--> listener/tts.py (Pocket TTS, offline) -> pw-cat -> speakers
camera -> listener/hands.py (MediaPipe, offline, only in gesture mode) --JSON lines--> app/src/gestures.js -> Hyprland IPC
```

- `listener/wake.py` decodes 16 kHz audio with a grammar-restricted Vosk model.
  Decoy words ("fried", "freddy", "fridge", ...) keep near-sounding speech from triggering.
  It fires at the end of an utterance, or earlier once a "friday" hypothesis is committed mid-sentence.
- The listener never records from a Bluetooth mic unless `FRIDAY_MIC` names one.
  An open Bluetooth mic forces the headset into the mono 16 kHz HFP call profile, which ruins playback.
  It also refuses to be moved to another source if its mic disappears; it re-selects one instead.
- After the wake word, `listener/command.py` records the command from the same stream.
  The recording starts exactly where "Friday" ended (Vosk word timings), so the wake word is never sent.
  Silero VAD (`listener/vad.py`) ends it after 1 s without speech, or gives up if nothing is said within 5 s; commands are capped at 15 s.
  It is a neural speech detector, so a fan, keyboard typing or other steady noise neither starts a command nor keeps one going.
  WebRTC VAD, used before, took both for speech and recorded every command for the full 15 s.
  The audio is then streamed to OpenAI (`gpt-transcribe`) and the text appears on the HUD as it arrives.
  Nothing leaves the machine before the wake word.
  The API client connects over IPv4 first and falls back to IPv6, so a network with a dead IPv6 route (common with phone tethering) does not stall commands.
  Behind a proxy (`HTTPS_PROXY`, `ALL_PROXY`) the proxy is used as configured instead.
- With a voiceprint enrolled, `listener/speaker.py` checks every command before it is sent: see [Speaker verification](#speaker-verification).
- `app/src/router.js` asks Jev, a typed-decision model, where each verified command should go: answered on this machine, labelled as a simple task, or sent to the agent. See [Intent routing](#intent-routing).
- `app/src/gestures.js` runs gesture control: see [Gesture control](#gesture-control).
- `app/src/agent.js` forwards the transcript of every command routed to the agent to a remote Hermes Agent API server, if one is configured, and streams the reply onto the HUD: see [Agent bridge](#agent-bridge).
  Nothing is installed locally and the bridge is inert until `FRIDAY_AGENT_URL` and `FRIDAY_AGENT_KEY` are set.
- `listener/tts.py` reads the reply aloud in a cloned voice as it streams in: see [Spoken replies](#spoken-replies).
- `app/src/main.js` keeps a hidden transparent window warm, so the HUD appears instantly.
  It supervises the listener and the voice and restarts them with backoff.
- `app/renderer` draws the HUD.
  Full-screen layers are static CSS animated only through opacity and transform, so the compositor handles them.
  Per-frame canvas work is limited to the reactor's bounding box, which keeps it smooth on integrated GPUs.
- The HUD powers down 12 s after the last speech or transcript, on Esc, or on a click outside the panels.
  It never powers down while a command is being recorded or transcribed, or while the reply is being read aloud.

## Install

```sh
python -m venv .venv && .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r listener/requirements.txt
mkdir -p models && curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o /tmp/m.zip && unzip /tmp/m.zip -d models
curl -L -o models/silero_vad.onnx https://github.com/snakers4/silero-vad/raw/v6.2/src/silero_vad/data/silero_vad.onnx
curl -L -o models/wespeaker_en_voxceleb_resnet34_LM.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
curl -L -o models/hand_landmarker.task https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
(cd app && npm install)
ln -sf "$PWD/systemd/friday.service" ~/.config/systemd/user/friday.service && systemctl --user daemon-reload
echo 'source = $HOME/Documents/friday/hypr/friday.conf' >> ~/.config/hypr/UserConfigs/WindowRules.conf
```

Put the OpenAI key in `.env` at the repository root (git-ignored):

```sh
OPENAI_API_KEY=sk-...
```

`hypr/friday.conf` holds the window rule (fullscreen overlay above bars) and starts the service on login.

For spoken replies, accept the terms of the gated [Pocket TTS](https://huggingface.co/kyutai/pocket-tts) voice cloning weights, log in once and clone a voice (see [Spoken replies](#spoken-replies)):

```sh
.venv/bin/hf auth login
bin/friday voice ~/recording-of-the-voice.wav
```

## Use

```sh
bin/friday wake | hide | toggle      # control the running instance
bin/friday gesture                   # turn hand gesture control on or off (SUPER+ALT+G)
bin/friday enroll                    # record your voiceprint (about a minute)
bin/friday voice FILE                # clone the voice replies are spoken in, from a recording
systemctl --user restart friday      # restart the service
journalctl --user -t friday -f       # logs
```

Settings live in the root `.env` (start from `cp .env.example .env && chmod 600 .env`).
The service, `bin/friday enroll` and `bin/friday voice` all read it, a variable already set in the
real environment wins over it, and `systemctl --user restart friday` applies a change:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRIDAY_MIC` | default source, or the best non-Bluetooth mic | PipeWire source name for `pw-record --target` |
| `FRIDAY_MIN_CONF` | `0.6` | Minimum Vosk word confidence |
| `FRIDAY_MODEL` | `models/vosk-model-small-en-us-0.15` | Vosk model directory |
| `FRIDAY_DEBUG` | unset | `1` logs steady-state fps after each wake |
| `FRIDAY_PYTHON` | `.venv/bin/python` | Python that runs the listener helpers |
| `OPENAI_API_KEY` | from `.env` | Without it the HUD reports that commands cannot be transcribed |
| `FRIDAY_STT_MODEL` | `gpt-transcribe` | OpenAI transcription model |
| `FRIDAY_STT_LANGUAGE` | `vi` | Language hint (ISO 639-1), or `auto`; English commands still transcribe correctly with `vi` |
| `FRIDAY_VAD_MODEL` | `models/silero_vad.onnx` | Silero VAD ONNX model that decides when a command starts and ends |
| `FRIDAY_VOICEPRINT` | `~/.local/share/friday/voiceprint.json` | Enrolled voiceprint; without the file any voice may command |
| `FRIDAY_SPEAKER_THRESHOLD` | `0.45` | Minimum voice match (cosine similarity, 0..1) |
| `FRIDAY_SPEAKER_MODEL` | `models/wespeaker_en_voxceleb_resnet34_LM.onnx` | WeSpeaker ONNX speaker model |
| `FRIDAY_VOICE_LOG` | unset | Folder to keep every scored voice sample in (private WAVs named by verdict and score), for tuning the threshold; delete it afterwards |
| `FRIDAY_AGENT_URL` | unset | Base URL of a remote Hermes Agent API server; unset disables the bridge (Friday only shows the transcript) |
| `FRIDAY_AGENT_KEY` | unset | Bearer token, the server's `API_SERVER_KEY` |
| `FRIDAY_AGENT_MODEL` | `hermes-agent` | Model id to request from the server |
| `FRIDAY_AGENT_SESSION` | `friday` | Prefix of the `X-Hermes-Session-Id` (`friday-20261014-203105`); empty makes each command stateless |
| `FRIDAY_AGENT_SESSION_IDLE_S` | `600` | A pause longer than this after the last reply starts a new conversation |
| `FRIDAY_AGENT_TIMEOUT_S` | `120` | Abandon a run after this many seconds |
| `JEV_API_KEY` | unset | JevStation (or TypeSafe) key for the intent router; unset sends every command to the agent |
| `FRIDAY_JEV_URL` | `https://jevstation.com/api/v1/systemone` | Jev endpoint; `https://api.typesafe.ai/v1/systemone` calls TypeSafe directly |
| `FRIDAY_JEV_MODEL` | `jev-1.13.0` | Jev model, pinned so the threshold does not drift with an alias |
| `FRIDAY_JEV_MIN_CONFIDENCE` | `0.5` | Below this confidence a command goes to the agent |
| `FRIDAY_JEV_TIMEOUT_S` | `8` | Give up on Jev and send the command to the agent |
| `FRIDAY_TTS` | on | `off` keeps replies silent and frees the voice model's memory |
| `FRIDAY_TTS_VOICE` | `models/tts-voice.safetensors` | Voice exported by `bin/friday voice`; without the file replies are silent |

## Agent bridge

With `FRIDAY_AGENT_URL` and `FRIDAY_AGENT_KEY` set, the transcript of every verified command is
sent as one user turn to a remote [Hermes Agent](https://hermes-agent.nousresearch.com/) API server,
and the reply streams onto the HUD under the command. Nothing is installed locally: the server runs
the agent, Friday only speaks HTTPS to it, and `app/src/agent.js` parses the OpenAI-compatible SSE
stream (`hermes.tool.progress` becomes a log line, `delta.content` streams the answer).

Enable the API server on the Hermes host (`~/.hermes/.env`) and start its gateway:

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=<a-long-random-secret>
# API_SERVER_HOST=127.0.0.1   # keep this and reach it through an SSH tunnel, or
#                             # expose it behind HTTPS on a fixed host
```

```sh
hermes gateway          # logs: [API Server] API server listening on http://127.0.0.1:8642
```

Then point Friday at it (see the table above), e.g. in the root `.env`:

```sh
FRIDAY_AGENT_URL=https://hermes.example.com
FRIDAY_AGENT_KEY=<the same secret>
```

Commands that come close together share one conversation, so "Friday, what's in this folder" can
be followed by "Friday, open the second one".
A pause longer than `FRIDAY_AGENT_SESSION_IDLE_S` after the last reply starts a new one, so an
unrelated question hours later does not drag old context (or its language) along; the HUD log says
`NEW CONVERSATION` or `CONTINUING` for each command.
Say "Friday, new conversation" (or "start over", "cuộc trò chuyện mới", "bắt đầu lại") to start one
right away; that command is answered locally and never sent to the agent.
The current session survives a restart (`conversation.json` in Electron's user data folder), and
remembering things across conversations is left to the agent's own memory.
Set `FRIDAY_AGENT_SESSION` empty to treat every command on its own.

While the agent is thinking or calling tools the HUD stays up, and a new wake abandons the
run in flight. If the server is unreachable the command is still shown and the reason is logged;
the wake word and transcription keep working exactly as before.

**Security.** The API server gives the bearer token the agent's *full* toolset, terminal included
(the server's own docs say so). Keep the token in the 0600 root `.env`, reach the server over HTTPS
or an SSH tunnel rather than plain HTTP, and restrict what the agent may do **on the server** - a
dedicated Hermes profile with a narrow toolset, exposed under `/p/<profile>/` with its own key - not
by trusting the client. Friday's voiceprint still decides whose speech is uploaded.

## Intent routing

With `JEV_API_KEY` set, every command is classified by [Jev](https://docs.typesafe.ai/introduction), TypeSafe's System One model, before anything handles it.
Jev is not a chat model: one request carries the transcript and a few typed questions, and returns typed answers with calibrated confidence.
`app/src/router.js` asks what the command wants (intent), whether it is a one-fact task (complexity), and, while a conversation is warm, whether it follows up on the agent's last answer.
Code, not a prompt, then picks the route, and `app/src/dispatch.js` carries it out:

| Route | Example | What happens |
| --- | --- | --- |
| `new_conversation` | "let's talk about something else" | The session is reset locally, as with the exact reset phrases |
| `cancel` | "never mind" | She stops talking; the HUD stays up |
| `time` | "mấy giờ rồi" | Answered locally, in the language of the command |
| `volume_up`, `volume_down`, `mute`, `unmute` | "turn it down a bit" | `wpctl` on the default sink, 10% steps, never above 100% |
| `simple` | "giá vàng hôm nay" | Only labelled (`SIMPLE TASK, NO HANDLER YET`); `onSimple` in `app/src/main.js` is where a quick answerer plugs in |
| `agent` | "list the newest files in Downloads" | Sent to Hermes, as before the router; a follow-up always stays with Hermes |

Jev never drops a command.
No key, an HTTP error, a timeout or an answer below `FRIDAY_JEV_MIN_CONFIDENCE` all send the command to the agent.
`cancel` and `new_conversation` end the request or discard the conversation, so they need at least 0.85 confidence; below that the agent gets the command.
The exact reset phrases are still matched locally and never cost a Jev call.
The HUD log shows `JEV ROUTE <ROUTE> <confidence>`, and the journal adds how long Jev took and the credits left.

Jev is a third party: it sees the transcript and, while a conversation is warm, the last command and the first 200 characters of the agent's reply.
The key is only ever sent over https.
A [JevStation](https://jevstation.com) key costs one credit per command (50 free credits, then paid packs).
JevStation answered in 1.4 to 5.9 s per call in October 2026, nearly all of it server side, so every routed command waits that long before it is handled.
A TypeSafe key with `FRIDAY_JEV_URL=https://api.typesafe.ai/v1/systemone` skips the reseller.

## Gesture control

Say "Friday, turn on gesture control" (or "bật điều khiển cử chỉ"), or press SUPER+ALT+G, and the webcam starts watching for your hands.
A small badge in the top-right corner shows that the camera is on and what it sees.

| Hands | Effect |
| --- | --- |
| 1 to 5 fingers held up for 0.5 s (thumb counts) | go to that workspace (`workspace N`) |
| a fist, then 1 to 5 fingers within 3 s | carry the focused window there and follow it (`movetoworkspace N`) |
| thumb on index tip (a pinch), dragged up / down | scroll the focused window a page on / back (Page Down / Page Up) |
| a pinch dragged right / left | back / forward (Alt+Left / Alt+Right) |
| both index fingers out, spread apart / brought together | zoom the screen in / out (`cursor:zoom_factor`, 1x to 4x) |

The camera image is mirrored, so "right" is your own right.
A count fires once: hold another count, make a fist, or take the hand away to fire again.
Going to the workspace you are already on does nothing, so `binds:workspace_back_and_forth` does not bounce you back.

Swipes go like a phone's: drag the page up to read on.
A vertical drag scrolls once for every tenth of the camera's view it covers; a sideways drag goes back or forward once per pinch.
A pinch only swipes the way it started, so bringing the hand back to scroll on, still pinching, scrolls nothing; open the fingers and pinch again to go the other way.
Swipes are keys Hyprland sends to the focused window (`sendshortcut`), so nothing needs installing.
While a hand pinches, finger counts are paused.

The zoom follows the spread between your hands: twice as far apart as when it took hold is twice the zoom.
It stays where you leave it, and the next pull zooms on from there; below 1.1x it snaps back to 1x.
Two hands in view hold finger commands off until no hand is, so the hand you lower last does not switch workspaces.
While the screen is zoomed in gesture control stays on, and turning it off zooms back out.

Gesture control turns itself off, and the camera with it, after 20 s without a hand in view (`FRIDAY_GESTURE_IDLE_S`), on "turn off gesture control", or on SUPER+ALT+G.
`FRIDAY_GESTURE_HOLD_MS`, `FRIDAY_GESTURE_GRAB_MS` and `FRIDAY_GESTURE_CARRY_MS` tune the timing.
`FRIDAY_GESTURE_DEBUG=1` adds a window in the bottom-right corner with the camera picture, the hand skeletons, the count and how close it is to firing.
Frames never leave the machine: MediaPipe runs on the CPU, and the debug pictures only go to the Electron shell.
The camera is read uncompressed (YUYV): a Logitech C270 sends MJPG that libjpeg warns about on every frame, at the same frame rate.
In a dim room auto exposure caps the frame rate (15 fps on the C270, 10 on the integrated camera), and tracking is smoother with more light.
MediaPipe imports `sounddevice`, whose PortAudio JACK backend gets the process killed on this setup; `hands.py` puts a stub in its place before loading MediaPipe.

## Spoken replies

The agent's reply is read aloud in a cloned voice with [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts), offline on the CPU.
`listener/tts.py` keeps the model loaded and receives the reply from the Electron shell as it streams in.
It speaks one sentence at a time, so the first words play while the agent is still writing the rest.
Markdown, links and code blocks are left out; Vietnamese sentences are shown but not spoken, since the voice is English only.
Saying "Friday" again stops her at once, and so does dismissing the HUD.

`bin/friday voice FILE` clones a voice from a recording in any format ffmpeg reads.
Use one clear voice without music or effects, ideally 10 to 30 s of it.
Pocket TTS conditions on at most 30 s and continues from where the sample stops, so the recording is cut at the last pause before 30 s rather than mid-word.
The trimmed sample is kept next to the voice as `models/tts-voice.wav`, to export it again after a model update.
`models/` is git-ignored: a voice cloned from someone else's recording stays on this machine.

Measured on the Ryzen 9 8945HX: about 1 GB of RAM while loaded, first audio about 240 ms after a sentence is complete, and audio generated about 1.4 times faster than it plays, on one to two CPU cores.
Pocket TTS runs one thread; more threads made it slower here.
Set `FRIDAY_TTS=off` to give the memory back.

## Speaker verification

`bin/friday enroll` asks you to say twelve short commands ("Friday, ...", Vietnamese and English) into the microphone Friday listens on: calmly, loudly as if across the room, higher or excited, and quickly.
The voiceprint has to cover how you really talk to Friday; enrolled from calm reading only, the same voice scored below the threshold when it was louder or higher.
Friday is paused while you enroll, so the prompts do not wake it.
Each becomes a 256-dimensional voice embedding from WeSpeaker ResNet34 (run with onnxruntime on the CPU, about 50 ms per command); together they are your voiceprint.
The file is private to your user (mode 0600) and the running service restarts to load it.
Samples that do not sound like the rest (a cough, someone else talking) are recorded again; if they still differ, nothing is saved and the previous voiceprint stays.
Enroll in your usual spot, with the microphone you normally use; enroll again after changing microphones.

For every command, the voiced part of the command is compared with the voiceprint.
A command with less than 1.5 s of speech is judged together with the spoken "Friday", because the model needs that much voice; a longer one must match on its own, so your "Friday" cannot vouch for someone else's command.
Below `FRIDAY_SPEAKER_THRESHOLD` the command is dropped before it reaches OpenAI, and the HUD shows "Voice not recognized" and powers down after a few seconds.
With under half a second of voice there is nothing to judge: the HUD asks you to say it again.
If the voiceprint cannot be used (corrupt, outdated, model missing) every command is rejected and the HUD says why; Friday never silently falls back to obeying anyone.

The model is fed the features WeSpeaker was trained on, including per-utterance mean normalisation, which cancels the microphone's level and colouring.
(sherpa-onnx 1.13.8 skips that step for this model; two strangers recorded on the same microphone then looked alike.)
Calibration on 13 held-out LibriSpeech speakers, all passed through one simulated laptop-microphone channel: clips of 1.5 to 3 s scored at least 0.50 for the enrolled speaker and at most 0.40 for everyone else.
Very short commands, colds, whispering or a noisy room lower your own score; recordings of your voice are accepted.
This keeps other people in the room from commanding Friday; it is not protection against a deliberate impostor.

## Test

```sh
.venv/bin/pytest -q listener                         # includes end-to-end decoding of espeak-ng speech and real-voice verification
FRIDAY_LIVE_API=1 .venv/bin/pytest -q listener -k live   # one real OpenAI transcription
cd app && npm test
```

## GPU note

Hyprland on this machine renders on the AMD iGPU and uses the RTX 5060 only to scan out the HDMI port.
Chromium buffers rendered on the NVIDIA GPU are rejected by the compositor, so the HUD renders on the iGPU.
Running the HUD on the RTX requires making it Hyprland's primary GPU (`env = AQ_DRM_DEVICES,/dev/dri/card1:/dev/dri/card2`), which affects the whole desktop and battery life.
