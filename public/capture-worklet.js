/*
  Browser-side audio capture.

  Runs on the audio thread, so a busy page cannot stall it — a dropped buffer
  here is a gap in the captions, and the reviewer sees the gap without ever
  learning it was the browser's fault.

  Downmixes to mono and converts to signed 16-bit, which is exactly what the
  bridge sends Soniox. Sample-rate conversion is deliberately NOT done here: the
  page opens its AudioContext at 16 kHz and refuses to capture if the browser
  will not give it, because a resampler written in a hurry is a quiet way to
  lose intelligibility.
*/

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;
    if (frames === 0) return true;

    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      const mono = sum / channels;
      // Clamp before scaling: a sample slightly over 1.0 wraps to a loud click
      // rather than clipping quietly.
      const clamped = mono > 1 ? 1 : mono < -1 ? -1 : mono;
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
