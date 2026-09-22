/**
 * A moving test pattern as a MediaStream, for `?source=test`.
 *
 * Lets a laptop tab act as a camera node, so the whole browser -> WebRTC ->
 * backend -> dashboard path can be checked without a phone. Drawn on a timer
 * rather than requestAnimationFrame so it keeps running in a background tab.
 */
export function startTestPattern(label: string, width = 1280, height = 720, fps = 30) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const started = performance.now();
  let frame = 0;

  const draw = () => {
    frame += 1;
    const t = (performance.now() - started) / 1000;
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, "#0b1220");
    g.addColorStop(1, "#1d2b45");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const cx = width * (0.5 + 0.36 * Math.sin(t * 0.8));
    const cy = height * (0.5 + 0.28 * Math.cos(t * 1.25));
    ctx.fillStyle = "#e2472a";
    ctx.beginPath();
    ctx.arc(cx, cy, height / 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px system-ui, sans-serif";
    ctx.fillText(label, 60, 110);
    ctx.font = "32px ui-monospace, monospace";
    ctx.fillText(`TEST PATTERN  frame ${frame}  ${new Date().toLocaleTimeString()}`, 60, height - 60);
  };

  draw();
  const timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);
  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
