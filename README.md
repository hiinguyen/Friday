# F.R.I.D.A.Y.

Always-on voice wake word for Linux (Hyprland/Wayland).
Say "Friday" and an Iron Man style HUD takes over the focused monitor.

## How it works

```
mic -> pw-record -> listener/wake.py (Vosk, offline) --JSON lines--> app/src (Electron main) --IPC--> app/renderer (HUD)
```

- `listener/wake.py` decodes 16 kHz audio with a grammar-restricted Vosk model.
  Decoy words ("fried", "freddy", "fridge", ...) keep near-sounding speech from triggering.
  It fires at the end of an utterance, or earlier once a "friday" hypothesis is committed mid-sentence.
- `app/src/main.js` keeps a hidden transparent window warm, so the HUD appears instantly.
  It supervises the listener and restarts it with backoff.
- `app/renderer` draws the HUD.
  Full-screen layers are static CSS animated only through opacity and transform, so the compositor handles them.
  Per-frame canvas work is limited to the reactor's bounding box, which keeps it smooth on integrated GPUs.
- The HUD powers down after 12 s without speech, on Esc, or on a click outside the panels.

## Install

```sh
python -m venv .venv && .venv/bin/pip install vosk pytest
mkdir -p models && curl -L https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -o /tmp/m.zip && unzip /tmp/m.zip -d models
(cd app && npm install)
ln -sf "$PWD/systemd/friday.service" ~/.config/systemd/user/friday.service && systemctl --user daemon-reload
echo 'source = $HOME/Documents/friday/hypr/friday.conf' >> ~/.config/hypr/UserConfigs/WindowRules.conf
```

`hypr/friday.conf` holds the window rule (fullscreen overlay above bars) and starts the service on login.

## Use

```sh
bin/friday wake | hide | toggle      # control the running instance
systemctl --user restart friday      # restart the service
journalctl --user -t friday -f       # logs
```

Environment (set with `systemctl --user set-environment`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRIDAY_MIC` | system default source | PipeWire source name for `pw-record --target` |
| `FRIDAY_MIN_CONF` | `0.6` | Minimum Vosk word confidence |
| `FRIDAY_MODEL` | `models/vosk-model-small-en-us-0.15` | Vosk model directory |
| `FRIDAY_DEBUG` | unset | `1` logs steady-state fps after each wake |

## Test

```sh
cd listener && ../.venv/bin/pytest -q      # includes end-to-end decoding of espeak-ng speech
cd app && npm test
```

## GPU note

Hyprland on this machine renders on the AMD iGPU and uses the RTX 5060 only to scan out the HDMI port.
Chromium buffers rendered on the NVIDIA GPU are rejected by the compositor, so the HUD renders on the iGPU.
Running the HUD on the RTX requires making it Hyprland's primary GPU (`env = AQ_DRM_DEVICES,/dev/dri/card1:/dev/dri/card2`), which affects the whole desktop and battery life.
