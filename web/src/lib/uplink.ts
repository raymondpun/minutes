import type { DigestBlock, LiveLine } from '../types';

type ServerEvent =
  | { type: 'ready'; meetingId: string }
  | { type: 'live'; start: number; end: number; text: string }
  | { type: 'digest'; block: DigestBlock }
  | { type: 'roll_call_ended'; at: number; namesHeard: string[] }
  | { type: 'chunk_ack'; index: number; seconds: number }
  | { type: 'error'; message: string };

export interface UplinkCallbacks {
  onLive: (line: LiveLine) => void;
  onDigest: (block: DigestBlock) => void;
  onRollCallEnded: (namesHeard: string[]) => void;
  onSecondsRecorded: (seconds: number) => void;
  onConnectionChange: (connected: boolean) => void;
}

/**
 * Ships audio to the server and survives the wifi in a meeting room.
 *
 * Meeting rooms are exactly where connections drop, so nothing is thrown away
 * on disconnect: audio queues in memory and flushes when the socket comes back.
 * The queue is capped because an unbounded buffer on a phone eventually kills
 * the tab -- and losing the oldest audio quietly beats losing all of it loudly.
 */
export class Uplink {
  private socket: WebSocket | null = null;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;

  /** ~5 minutes of 16 kHz mono PCM. Past that the network is not coming back. */
  private static readonly MAX_QUEUE_BYTES = 5 * 60 * 32_000;

  constructor(
    private readonly meetingId: string,
    private readonly callbacks: UplinkCallbacks,
  ) {}

  connect(): void {
    if (this.closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(
      `${protocol}//${location.host}/ws?meeting=${encodeURIComponent(this.meetingId)}`,
    );
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.callbacks.onConnectionChange(true);
      this.flush();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerEvent;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'live') {
        this.callbacks.onLive({
          start: message.start,
          end: message.end,
          text: message.text,
        });
      } else if (message.type === 'digest') {
        this.callbacks.onDigest(message.block);
      } else if (message.type === 'roll_call_ended') {
        this.callbacks.onRollCallEnded(message.namesHeard);
      } else if (message.type === 'chunk_ack') {
        this.callbacks.onSecondsRecorded(message.seconds);
      }
    };

    socket.onclose = () => {
      this.callbacks.onConnectionChange(false);
      this.socket = null;
      if (this.closed) return;
      // 1s, 2s, 4s, capped at 10s. Keep trying for the whole meeting.
      const delay = Math.min(10_000, 1_000 * 2 ** this.reconnectAttempt++);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => {
      // onclose always follows, and that is where reconnection is handled.
    };
  }

  send(pcm: ArrayBuffer): void {
    this.queue.push(pcm);
    this.queuedBytes += pcm.byteLength;

    while (this.queuedBytes > Uplink.MAX_QUEUE_BYTES && this.queue.length > 1) {
      const dropped = this.queue.shift();
      this.queuedBytes -= dropped?.byteLength ?? 0;
    }

    this.flush();
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    // bufferedAmount guards against filling the socket faster than the phone's
    // uplink drains it, which on bad wifi turns into unbounded memory growth.
    while (this.queue.length && socket.bufferedAmount < 1_000_000) {
      const chunk = this.queue.shift()!;
      this.queuedBytes -= chunk.byteLength;
      socket.send(chunk);
    }
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  /** Wait for the backlog to drain before telling the server the meeting ended. */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.flush();
      const socketDrained = !this.socket || this.socket.bufferedAmount === 0;
      if (this.queue.length === 0 && socketDrained) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }
}
