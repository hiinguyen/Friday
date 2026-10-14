'use strict';

// Supervises listener/tts.py, which speaks the agent's replies in the cloned
// voice. Replies are streamed in as they arrive (say), closed with end, and
// silenced with cancel (a new wake, or the HUD dismissed).

const { PythonWorker } = require('./worker');

const SPEECH_STATES = new Set(['speaking', 'done', 'skipped']);

class SpeechOutput extends PythonWorker {
  constructor({ backoffMs } = {}) {
    super('tts.py', { name: 'tts', backoffMs, input: true });
    this.replyId = null; // reply being streamed in (said, not yet ended)
    this.speakingId = null; // reply the worker reported it is speaking
    this.lostId = null; // reply cut off by a worker crash: its rest is not spoken
    this.on('down', () => this.onDown());
  }

  /** Queue the next piece of reply `id`; a new id silences the previous reply. */
  say(id, text) {
    if (!text || id === this.lostId) return;
    this.lostId = null; // a newer reply: ids restart with the listener, so forget the lost one
    this.replyId = id;
    this.send({ type: 'say', id, text });
  }

  /** Reply `id` is complete: speak whatever is left of it. */
  end(id) {
    if (id === this.replyId) this.replyId = null;
    if (id !== this.lostId) this.send({ type: 'end', id });
  }

  /** Stop talking now. */
  cancel() {
    this.send({ type: 'cancel' });
  }

  /** The worker died: a restarted one would start mid-reply, and nobody would ever say it stopped. */
  onDown() {
    if (this.replyId !== null) this.lostId = this.replyId;
    this.replyId = null;
    if (this.speakingId !== null) {
      const id = this.speakingId;
      this.speakingId = null;
      this.emit('speech', { id, state: 'done' });
    }
  }

  onEvent(event, line) {
    switch (event.type) {
      case 'ready':
        this.emit('ready', { voice: String(event.voice ?? '') });
        break;
      case 'disabled':
        // No voice to speak with: the worker exits on its own and stays down.
        this.retire();
        this.emit('disabled', String(event.reason ?? 'disabled'));
        break;
      case 'speech':
        if (!SPEECH_STATES.has(event.state)) {
          super.onEvent(event, line);
          break;
        }
        if (event.state === 'speaking') this.speakingId = event.id;
        else if (event.state === 'done' && event.id === this.speakingId) this.speakingId = null;
        this.emit('speech', { id: event.id, state: event.state });
        break;
      case 'error':
        this.emit('error', event.message);
        break;
      default:
        super.onEvent(event, line);
    }
  }
}

module.exports = { SpeechOutput };
