/**
 * Keep the screen awake for the length of the meeting.
 *
 * This is not a nicety. On iOS, Safari suspends the audio context when the
 * screen locks, and a phone left on a table locks after a minute. Without a
 * wake lock the app records the first sixty seconds of a ninety minute meeting
 * and nothing else.
 *
 * Wake Lock is supported in Safari 16.4+ and Chrome. Where it is missing, the
 * caller shows an instruction to turn off auto-lock instead -- the app must not
 * pretend it is safe when it is not.
 */
export class ScreenLockGuard {
  private sentinel: WakeLockSentinel | null = null;
  private released = false;
  private onVisibility = () => {
    // The lock is dropped automatically whenever the page is hidden, so it has
    // to be retaken every time the user comes back to the app.
    if (document.visibilityState === 'visible' && !this.released) {
      void this.acquire();
    }
  };

  static get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  async acquire(): Promise<boolean> {
    if (!ScreenLockGuard.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      document.addEventListener('visibilitychange', this.onVisibility);
      return true;
    } catch {
      // Denied, or the battery saver refused. Not fatal, but the caller warns.
      return false;
    }
  }

  async release(): Promise<void> {
    this.released = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* already gone */
    }
    this.sentinel = null;
  }
}

export const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
