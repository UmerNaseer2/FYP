/**
 * Draws assets/icon.png, the picture Ubuntu shows for Schema Studio in the
 * app grid, the dock and the About box, from assets/icon.svg.
 *
 * Ubuntu's icon themes take PNG files, and electron-builder makes every size
 * they need from one large PNG, so the PNG is 1024 x 1024. Electron's own
 * Chromium draws it, so nothing else has to be installed, and the picture
 * comes out the same on every computer. The PNG is committed, so a build
 * does not run this. Run it again after changing icon.svg:
 *
 *   npm run make-icon
 *
 * The mark sits a little inside the edges, as the icons next to it in
 * Ubuntu's dock do, so that it does not look bigger than they do.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
const MARGIN = 52;
const DRAWN = SIZE - 2 * MARGIN;
const assetsDir = path.resolve(__dirname, "..", "assets");
const svgFile = path.join(assetsDir, "icon.svg");
const pngFile = path.join(assetsDir, "icon.png");

// Drawing in software comes out the same on every computer, graphics card or not.
app.disableHardwareAcceleration();

function stop(message) {
  console.error(message);
  app.exit(1);
}

// Drawing takes well under a second, so anything this slow is stuck.
const timer = setTimeout(() => stop("Drawing the icon took too long. Try again."), 15000);

/** Runs in the page: draws the SVG on a canvas, checks it, and returns the PNG as a data: URL. */
async function draw(svgText, size, margin, drawn) {
  const svg = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (svg.documentElement.nodeName !== "svg" || svg.getElementsByTagName("parsererror").length > 0) {
    throw new Error("assets/icon.svg is not a valid SVG picture.");
  }
  // At its final size, the picture is drawn sharp instead of being
  // enlarged from its 32 pixels.
  svg.documentElement.setAttribute("width", String(drawn));
  svg.documentElement.setAttribute("height", String(drawn));
  // A data: picture counts as the page's own, so the canvas can be read back.
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.drawImage(image, margin, margin, drawn, drawn);
  // The mark's rounded corners must stay see-through, and its middle must not.
  const corner = context.getImageData(margin + 2, margin + 2, 1, 1).data[3];
  const middle = context.getImageData(size / 2, size / 2, 1, 1).data[3];
  if (corner !== 0 || middle === 0) throw new Error("The icon did not come out as expected.");
  return canvas.toDataURL("image/png");
}

app
  .whenReady()
  .then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    const page = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await page.loadURL("about:blank");
    const svgText = fs.readFileSync(svgFile, "utf8");
    // An error thrown in the page arrives here without its message, so the
    // page hands it back as a value instead.
    const result = await page.webContents.executeJavaScript(
      `(${draw.toString()})(${JSON.stringify(svgText)}, ${SIZE}, ${MARGIN}, ${DRAWN}).then((png) => ({ png }), (error) => ({ error: String(error?.message ?? error) }))`,
    );
    if (result.error !== undefined) throw new Error(result.error);
    fs.writeFileSync(pngFile, Buffer.from(result.png.slice(result.png.indexOf(",") + 1), "base64"));
    clearTimeout(timer);
    console.log(`Wrote assets/icon.png (${SIZE} x ${SIZE}).`);
    app.quit();
  })
  .catch((error) => stop(`The icon could not be drawn: ${error.message}`));
