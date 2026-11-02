// The unread count on Windows, on the taskbar's button and over the tray's icon, drawn
// as Telegram draws them (GenerateCounterLayer and WithSmallCounter in tdesktop). The
// main process has nothing to draw text with. Sizes are for 100%, and scale with the screen.

const RED = "#f23c34";
const SIZE = 16;

interface Shape {
  text: string;
  font: number;
  delta: number;
  radius: number;
}

function draw({ text, font, delta, radius }: Shape, ratio: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.round(SIZE * ratio);
  const context = canvas.getContext("2d")!;
  context.scale(canvas.width / SIZE, canvas.height / SIZE);

  // Smaller until it fits, with the margin it would otherwise have left.
  const skip = Math.max(delta - 1, 1);
  const measure = () => {
    context.font = `600 ${font}px "Segoe UI", sans-serif`;
    return context.measureText(text);
  };
  let metrics = measure();
  while (font > 1 && metrics.width + delta + skip > SIZE) {
    font -= 0.5;
    metrics = measure();
  }

  const width = metrics.width;
  const height = Math.ceil(font * 1.3);
  const left = Math.max(SIZE - width - delta * 2, 0);
  const top = SIZE - height;
  context.fillStyle = RED;
  context.beginPath();
  context.roundRect(left, top, SIZE - left, height, Math.min(radius, height / 2));
  context.fill();

  context.fillStyle = "#fff";
  context.fillText(text, left + (SIZE - left - width) / 2, top + (height + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
  return canvas.toDataURL("image/png");
}

/** What goes on the taskbar's button: large enough to read at a glance. */
function overlay(count: number, ratio: number): string {
  const text = count < 1000 ? String(count) : `..${String(count % 100).padStart(2, "0")}`;
  if (text.length < 2) return draw({ text, font: 11, delta: 5, radius: 8 }, ratio);
  if (text.length < 3) return draw({ text, font: 11, delta: 2, radius: 7 }, ratio);
  return draw({ text, font: 8, delta: 1, radius: 3 }, ratio);
}

/** What goes in a corner of the tray's icon, which should still show through. */
function trayCounter(count: number, ratio: number): string {
  const text = count < 100 ? String(count) : `..${count % 10}`;
  const one = text.length < 2;
  return draw({ text, font: SIZE / 2 + 1, delta: SIZE / (one ? 8 : 16), radius: SIZE / (one ? 4 : 5) }, ratio);
}

export function drawCounters(count: number): { overlay: string; tray: string } {
  const ratio = window.devicePixelRatio;
  return { overlay: overlay(count, ratio), tray: trayCounter(count, ratio) };
}
