/**
 * iOS suspends the WKWebView content process when the app is backgrounded,
 * even though the native player keeps audio going. That freezes the JS poll
 * which arms crossfades and advances the queue after a track ends.
 *
 * A looping, silent HTMLAudioElement gives WebKit a media playback assertion,
 * which keeps the renderer (and therefore the native bridge) running. The
 * samples are digital silence, so nothing is audible.
 */

let element: HTMLAudioElement | null = null;
let listening = false;

function silentWavDataUri(): string {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 2; // 0.5s, small enough to loop cheaply
  const buffer = new ArrayBuffer(44 + sampleCount);
  const view = new DataView(buffer);

  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  write(36, "data");
  view.setUint32(40, sampleCount, true);
  // 8-bit PCM silence is 0x80, not zero.
  new Uint8Array(buffer, 44).fill(0x80);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function ensureElement(): HTMLAudioElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (element) return element;

  const audio = document.createElement("audio");
  audio.src = silentWavDataUri();
  audio.loop = true;
  audio.preload = "auto";
  // Keep the element audible to WebKit: muting or volume 0 can make it
  // ineligible for the background assertion. The samples themselves are silent.
  audio.volume = 1;
  audio.setAttribute("playsinline", "");
  audio.setAttribute("aria-hidden", "true");
  audio.style.display = "none";
  document.body.appendChild(audio);
  element = audio;

  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void element?.play().catch(() => {});
    });
  }
  return audio;
}

/** Starts (or resumes) the keepalive. Safe to call repeatedly. */
export function startBackgroundAudioKeepAlive(): void {
  const audio = ensureElement();
  if (!audio) return;
  void audio.play().catch(() => {});
}

/** Stops the keepalive when playback is fully stopped. */
export function stopBackgroundAudioKeepAlive(): void {
  if (!element) return;
  try {
    element.pause();
  } catch {}
}
