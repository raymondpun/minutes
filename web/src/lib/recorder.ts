/**
 * Microphone capture for a phone sitting on a meeting table.
 *
 * Why raw PCM over an AudioWorklet rather than MediaRecorder:
 *
 *   MediaRecorder's timeslice chunks after the first are container fragments
 *   with no header. Sending fragment 7 to a transcription API on its own does
 *   not decode. Stopping and restarting the recorder every 20s produces valid
 *   files but drops audio at every seam, and 270 seams in a 90 minute meeting
 *   is 270 chances to lose the word that mattered.
 *
 *   Raw PCM has neither problem: it concatenates by appending, and any slice of
 *   it is valid audio. The server keeps the master copy, so the phone holds
 *   almost nothing in memory and a browser crash mid-meeting costs seconds
 *   rather than everything.
 *
 * Works identically on iOS Safari and Android Chrome -- there is no codec to
 * negotiate, which is the other half of why MediaRecorder is not used here.
 */

const TARGET_SAMPLE_RATE = 16_000;

/** Post ~1s of audio at a time: small enough to feel live, large enough to be cheap. */
const EMIT_SAMPLES = TARGET_SAMPLE_RATE;

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.count = 0;
    // Post roughly every 4096 samples rather than every 128-sample render
    // quantum, or we spend the meeting doing postMessage.
    this.threshold = 4096;
    // Up to 4095 samples sit here below the threshold. On stop that is a
    // quarter of a second of audio -- the last word of the meeting, and again
    // at every pause -- so the main thread can ask for it before tearing down.
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
  }
  flush() {
    if (!this.count) return;
    const merged = new Float32Array(this.count);
    let offset = 0;
    for (const b of this.buffer) { merged.set(b, offset); offset += b.length; }
    this.port.postMessage(merged, [merged.buffer]);
    this.buffer = [];
    this.count = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.buffer.push(new Float32Array(channel));
      this.count += channel.length;
      if (this.count >= this.threshold) this.flush();
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export interface RecorderCallbacks {
  /** Called with ~1s of 16 kHz mono little-endian 16-bit PCM. */
  onAudio: (pcm: ArrayBuffer) => void;
  /** 0..1, for the level meter. Fires ~10x/second. */
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
}

export interface RecorderHandle {
  stop: () => Promise<void>;
  /** Actual hardware sample rate, useful when diagnosing a bad recording. */
  sampleRate: number;
  deviceLabel: string;
}

export async function startRecorder(
  callbacks: RecorderCallbacks,
  deviceId?: string,
): Promise<RecorderHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'This browser cannot access the microphone. On iPhone you must use Safari, and the page must be served over HTTPS.',
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      // These defaults are tuned for one person on a phone call, and they work
      // against us here. Echo cancellation has nothing to cancel with no
      // speaker playing, and noise suppression treats the quiet person at the
      // far end of the table as noise. Gain control genuinely helps pull in
      // distant voices, so that one stays on.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
    video: false,
  });

  const track = stream.getAudioTracks()[0];
  const deviceLabel = track?.label || 'Default microphone';

  // Everything from here can throw -- the AudioContext constructor, resume()
  // rejecting on iOS, addModule() being blocked by a CSP. Without this the
  // microphone stays live with no recorder attached to it: the phone's
  // recording indicator on, nothing being captured, and the retry failing with
  // "the microphone is in use by another app" pointing at an app that is us.
  let context: AudioContext | undefined;
  try {
    return await setUp();
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    await context?.close().catch(() => {});
    throw err;
  }

  async function setUp(): Promise<RecorderHandle> {

  // Ask for 16 kHz directly -- most browsers honour it and skip the resample.
  const AudioCtor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  try {
    context = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    context = new AudioCtor();
  }
  const ctx = context;

  // iOS starts contexts suspended until a user gesture has been handled.
  if (ctx.state === 'suspended') await ctx.resume();

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
  );

  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });

  const inputRate = ctx.sampleRate;
  const needsResample = Math.abs(inputRate - TARGET_SAMPLE_RATE) > 1;

  let carry = new Float32Array(0);
  /** Input samples left over between blocks, so the resampler keeps its phase. */
  let inputCarry = new Float32Array(0);
  let levelCounter = 0;

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    try {
      const incoming = event.data;

      // Level meter off the raw signal, before any resampling.
      if (levelCounter++ % 2 === 0) {
        callbacks.onLevel(rms(incoming));
      }

      let samples: Float32Array;
      if (needsResample) {
        // Resample across the block boundary, not within it. Restarting at
        // phase zero every block silently discarded the remainder each time --
        // at 48 kHz that is 2 samples per 4096, a 0.024% timebase error that
        // deletes over a second from a 90 minute meeting and shifts every
        // timestamp with it, plus a sampling discontinuity ~12 times a second
        // that is audible as roughness on every voice in the room.
        const merged = concat(inputCarry, incoming);
        const { out, consumed } = downsample(merged, inputRate / TARGET_SAMPLE_RATE);
        inputCarry = merged.slice(consumed);
        samples = out;
      } else {
        samples = incoming;
      }

      const merged = new Float32Array(carry.length + samples.length);
      merged.set(carry, 0);
      merged.set(samples, carry.length);

      let offset = 0;
      while (merged.length - offset >= EMIT_SAMPLES) {
        const slice = merged.subarray(offset, offset + EMIT_SAMPLES);
        callbacks.onAudio(floatToInt16(slice));
        offset += EMIT_SAMPLES;
      }
      carry = merged.slice(offset);
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  source.connect(node);

  // A track ending mid-meeting means the OS took the mic away -- another app
  // grabbed it, or the headset disconnected. Silent failure here would cost the
  // whole meeting, so it surfaces immediately.
  track?.addEventListener('ended', () => {
    callbacks.onError(
      new Error('The microphone stopped. Another app may have taken it, or a headset disconnected.'),
    );
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;

    // Ask the worklet for whatever it is still holding below its post
    // threshold, and give it a moment to arrive, before tearing anything down.
    try {
      node.port.postMessage('flush');
      await new Promise((r) => setTimeout(r, 60));
    } catch {
      /* already gone */
    }

    // Flush the tail so the last partial second is not thrown away.
    if (carry.length > 0) {
      callbacks.onAudio(floatToInt16(carry));
      carry = new Float32Array(0);
    }

    node.port.onmessage = null;
    try {
      source.disconnect();
      node.disconnect();
    } catch {
      /* already torn down */
    }
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch(() => {});
  };

  return { stop, sampleRate: inputRate, deviceLabel };
  }
}

/**
 * Downsample by averaging each output sample's window of input.
 *
 * Averaging rather than picking: at 48 kHz the ratio is exactly 3, so linear
 * interpolation degenerated into taking every third sample with no filtering
 * at all, folding 8-24 kHz -- sibilance, fans, aircon hiss -- straight down
 * into the speech band. A box average over the window is a crude lowpass, but
 * it is a lowpass, and it costs nothing.
 *
 * Returns how much input it consumed so the caller can carry the remainder and
 * keep the phase continuous across blocks.
 */
function downsample(
  input: Float32Array,
  ratio: number,
): { out: Float32Array; consumed: number } {
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = i * ratio;
    const end = start + ratio;
    let sum = 0;
    let n = 0;
    for (let j = Math.floor(start); j < Math.min(Math.ceil(end), input.length); j++) {
      sum += input[j] ?? 0;
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return { out, consumed: Math.floor(length * ratio) };
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function floatToInt16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  // Scaled so normal speech sits in the middle of the meter rather than
  // hugging the bottom.
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}
