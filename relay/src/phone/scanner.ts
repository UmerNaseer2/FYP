/**
 * The camera and the QR code reader on the Scan screen. The reader is jsQR,
 * which `npm run build` copies to public/js/vendor, and it is loaded only
 * when a phone first scans. It looks at a square from the middle of the
 * camera's picture a few times a second (scan.ts works out the square).
 */
import { scanSquare } from "./scan.js";

type ReadQr = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" }) => { data: string } | null;

const QR_READER_URL = "/js/vendor/jsQR.js";
const READ_EVERY_MS = 150;

let reader: Promise<ReadQr> | null = null;

/** jsQR, loaded once, and again only after loading it failed. */
function loadQrReader(): Promise<ReadQr> {
  const loaded = (globalThis as { jsQR?: unknown }).jsQR;
  if (typeof loaded === "function") return Promise.resolve(loaded as ReadQr);
  if (reader !== null) return reader;
  const attempt = new Promise<ReadQr>((resolve, reject) => {
    const script = el("script");
    script.src = QR_READER_URL;
    script.addEventListener("load", () => {
      const found = (globalThis as { jsQR?: unknown }).jsQR;
      if (typeof found === "function") resolve(found as ReadQr);
      else reject(new Error("The QR code reader could not be loaded. Check the phone's internet connection, then try again."));
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("The QR code reader could not be loaded. Check the phone's internet connection, then try again."));
    });
    document.head.append(script);
  });
  reader = attempt;
  attempt.catch(() => {
    if (reader === attempt) reader = null;
  });
  return attempt;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

/** The camera's failure as a sentence a person can act on. Not every browser's errors are DOMExceptions, so only the name is read. */
function cameraError(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The browser was not allowed to use the camera. Allow the camera for this site in the browser's settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "This device has no camera the browser can use.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is in use by another app, or could not be started. Close the other app, then try again.";
  }
  return "The camera could not be started. Try again.";
}

export type ScannerEvents = {
  /** The camera's picture is showing and the reader is looking at it. */
  started(): void;
  /** The reader found a QR code with this text. It keeps looking until it is stopped. */
  found(text: string): void;
  /** The camera or the reader could not be used, and the scanner has stopped. */
  failed(message: string): void;
};

/** Starts the camera in `video` and reads QR codes from it, until the function this returns is called. */
export function startScanner(video: HTMLVideoElement, events: ScannerEvents): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: MediaStream | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    video.srcObject = null;
  };
  const fail = (message: string): void => {
    if (stopped) return;
    stop();
    events.failed(message);
  };
  // The reader loads while the camera starts, and a failure is told once it is needed.
  loadQrReader().catch(() => {});
  void (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      fail("This browser cannot use the camera here.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (error) {
      fail(cameraError(error));
      return;
    }
    if (stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    for (const track of stream.getTracks()) track.addEventListener("ended", () => fail("The camera stopped. Try again."));
    video.srcObject = stream;
    let readQr: ReadQr;
    try {
      await video.play();
      readQr = await loadQrReader();
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith("The QR") ? error.message : cameraError(error));
      return;
    }
    if (stopped) return;
    const canvas = el("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      fail("The camera could not be started. Try again.");
      return;
    }
    events.started();
    const read = (): void => {
      if (stopped) return;
      const square = video.readyState >= video.HAVE_CURRENT_DATA ? scanSquare(video.videoWidth, video.videoHeight) : null;
      if (square !== null) {
        canvas.width = square.drawSide;
        canvas.height = square.drawSide;
        context.drawImage(video, square.x, square.y, square.side, square.side, 0, 0, square.drawSide, square.drawSide);
        const image = context.getImageData(0, 0, square.drawSide, square.drawSide);
        // The computer draws its code black on white, so the reader need not try it the other way round.
        const found = readQr(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (found !== null && found.data !== "") events.found(found.data);
        if (stopped) return;
      }
      timer = setTimeout(read, READ_EVERY_MS);
    };
    read();
  })();
  return stop;
}
