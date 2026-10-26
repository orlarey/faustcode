// play-gate.js — phone helpers for the audio gate « Tap to play »
// (spec_share_url.md, part 3). Everything a single user gesture must do
// on iOS : sensor permission, playback audio session.

export function isTouchDevice() {
  return (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
    || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && 'ontouchstart' in window);
}

/** True when the Faust source declares [acc:…] or [gyr:…] metadata. */
export function codeWantsSensors(code) {
  return /\[\s*(acc|gyr)\s*:/.test(String(code || ''));
}

/**
 * iOS 13+ : DeviceMotionEvent / DeviceOrientationEvent.requestPermission()
 * must be CALLED synchronously inside the user gesture — call this first
 * in the click handler, before any await. Elsewhere no permission is
 * needed.
 * @returns {Promise<'granted' | 'denied' | 'not-needed'>}
 */
export function requestSensorPermission() {
  const asks = [];
  for (const Ev of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
    if (Ev && typeof Ev.requestPermission === 'function') {
      try {
        asks.push(Ev.requestPermission());
      } catch (err) {
        asks.push(Promise.reject(err));
      }
    }
  }
  if (asks.length === 0) return Promise.resolve('not-needed');
  return Promise.allSettled(asks).then((results) =>
    results.every((r) => r.status === 'fulfilled' && r.value === 'granted') ? 'granted' : 'denied');
}

/**
 * Safari 16.4+ : play Web Audio even when the iPhone ring/silent switch
 * is on silent (otherwise Web Audio is muted).
 */
export function setPlaybackAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // ignore
  }
}
