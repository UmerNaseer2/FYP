/**
 * Draws the pairing code that Settings shows: the pairing link as a QR code,
 * for a phone's camera to read.
 *
 * Settings gets only the drawing, never the link, because the link carries a
 * one-time secret that pairs a phone. The drawing is SVG path data: runs of
 * dark squares one square high, in a square `size` squares wide that includes
 * the light border round the code. The page fills it in black on white.
 */
import qrcode from "qrcode-generator";

/** How many light squares surround the code. The QR standard asks for four, so that a camera can find its edges. */
const QUIET_ZONE = 4;

/**
 * `text` (plain ASCII, as a pairing link always is) as a QR code with medium
 * error correction, in the smallest version that holds it.
 */
export function pairingQr(text: string): { size: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    let column = 0;
    while (column < count) {
      if (!code.isDark(row, column)) {
        column += 1;
        continue;
      }
      // One rectangle for each run of dark squares keeps the drawing small.
      const start = column;
      while (column < count && code.isDark(row, column)) column += 1;
      const width = column - start;
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${width}v1h-${width}z`);
    }
  }
  return { size: count + QUIET_ZONE * 2, path: parts.join("") };
}
