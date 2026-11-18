// What the App Store art in this folder shares: devices around simulator captures, and the faint network behind them.

// Adds an iPhone or iPad showing the capture `screen` to `parent` and returns it, sized by the width of its screen.
// A flat device is seen straight on, so only its buttons stick out of its outline; any other one gets a body of thin
// slabs stacked behind its front, which tiltDevice turns in 3D to show the rounded edge.
//   kind       "iphone" or "ipad"
//   landscape  an iPad lying on its side, for a landscape capture
//   rim, bezel optional widths in px instead of the device's own
//   className  more classes, for example to position it, which tiltDevice needs done first
function createDevice(parent, { kind, screen, screenWidth, landscape = false, flat = false, rim, bezel, className }) {
  const device = document.createElement("div");
  device.className = ["device", kind, landscape && "landscape", flat && "flat", className].filter(Boolean).join(" ");
  device.style.setProperty("--screen-w", `${screenWidth}px`);
  if (rim !== undefined) device.style.setProperty("--rim", `${rim}px`);
  if (bezel !== undefined) device.style.setProperty("--bezel", `${bezel}px`);
  device.innerHTML = `
    <div class="front">
      <div class="bezel"></div>
      <div class="screen"><img><div class="glare"></div></div>
      ${kind === "ipad" ? '<div class="camera"></div>' : '<div class="island"></div>'}
    </div>`;
  device.querySelector("img").src = screen;
  parent.append(device);

  const width = device.offsetWidth, height = device.offsetHeight;
  // Buttons of the upright device as [edge, start, length], start and length as fractions of that edge: the iPhone's
  // action and volume buttons on the left and its side button on the right; the iPad's top button and its volume
  // buttons on the right. Lying on its side (turned counter-clockwise), the iPad's top edge becomes its left one and
  // its right edge its top one.
  let buttons = kind === "ipad"
    ? [["top", 0.74, 0.09], ["right", 0.075, 0.05], ["right", 0.135, 0.05]]
    : [["left", 0.155, 0.036], ["left", 0.222, 0.072], ["left", 0.31, 0.072], ["right", 0.25, 0.105]];
  if (landscape) {
    buttons = buttons.map(([edge, start, length]) => edge === "top" ? ["left", 1 - start - length, length] : ["top", start, length]);
  }
  const addButton = (slab, edge, start, length, color) => {
    const button = document.createElement("div");
    button.className = "button";
    const position = edge === "top"
      ? `top:-6px;left:${start * width}px;width:${length * width}px;height:14px`
      : `${edge}:-6px;top:${start * height}px;height:${length * height}px;width:14px`;
    button.style.cssText = `${position};background:${color}`;
    slab.appendChild(button);
  };

  if (flat) {
    const slab = document.createElement("div");
    slab.className = "slab";
    const shading = { left: "90deg", right: "270deg", top: "180deg" };
    for (const [edge, start, length] of buttons) {
      addButton(slab, edge, start, length, `linear-gradient(${shading[edge]}, #8e8e95, #3a3a40)`);
    }
    device.insertBefore(slab, device.firstChild);
    return device;
  }

  // The body is as thick as the real device for its width: the iPhone a little over a tenth, the iPad much thinner.
  // Each layer keeps its depth for tiltDevice.
  device.querySelector(".front").dataset.z = 0.5;
  const depth = Math.min(width, height) * (kind === "ipad" ? 0.026 : 0.105);
  const step = kind === "ipad" ? 1.25 : 1.5;
  const count = Math.round(depth / step);
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    // Bright chamfer just behind the front, darker metal in the middle, a softer highlight at the back.
    const light = t < 0.08 ? 62 - t * 300 : t > 0.9 ? 30 + (t - 0.9) * 140 : 34 - Math.sin(t * Math.PI) * 6;
    const slab = document.createElement("div");
    slab.className = "slab";
    slab.dataset.z = -i * step;
    slab.style.background = `linear-gradient(180deg, hsl(240 4% ${light + 10}%) 0%, hsl(240 4% ${light}%) 22%, hsl(240 4% ${light - 8}%) 55%, hsl(240 4% ${light + 4}%) 100%)`;
    if (t > 0.3 && t < 0.7) {
      for (const [edge, start, length] of buttons) addButton(slab, edge, start, length, `hsl(240 4% ${light + 6}%)`);
    }
    device.insertBefore(slab, device.firstChild);
  }
  return device;
}

// Turns a device from createDevice in 3D (`transform`, about its center), seen through its parent's perspective.
// Every layer gets the whole turn on its own instead of the layers sharing one 3D scene, and the browser paints them in
// order, back to front. In a shared scene Chrome sorts the many parallel layers itself and now and then draws the body
// over the front.
function tiltDevice(device, transform) {
  const parent = getComputedStyle(device.parentElement);
  const [x, y] = parent.perspectiveOrigin.split(" ").map(parseFloat);
  device.style.perspective = parent.perspective;
  device.style.perspectiveOrigin = `${x - device.offsetLeft}px ${y - device.offsetTop}px`;
  for (const layer of device.children) layer.style.transform = `${transform} translateZ(${layer.dataset.z}px)`;
}

// Draws a faint network into `svg`: every node joins its two nearest neighbours on its own side of the canvas, and
// the nodes in `lit` glow orange.
function drawNetwork(svg, width, height, points, lit) {
  const links = new Set();
  const half = width / 2;
  points.forEach(([x, y], i) => {
    points.map((p, j) => [j, (p[0] - x) ** 2 + (p[1] - y) ** 2])
      .filter(([j]) => j !== i && (points[j][0] < half) === (x < half))
      .sort((a, b) => a[1] - b[1]).slice(0, 2)
      .forEach(([j]) => links.add([Math.min(i, j), Math.max(i, j)].join("-")));
  });
  let d = "";
  for (const key of links) {
    const [a, b] = key.split("-").map(Number);
    d += `M${points[a][0]} ${points[a][1]}L${points[b][0]} ${points[b][1]}`;
  }
  let content = `<path d="${d}" fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="2"/>`;
  points.forEach(([x, y], i) => {
    content += lit.has(i)
      ? `<circle cx="${x}" cy="${y}" r="18" fill="#ff8a1f" fill-opacity="0.16"/><circle cx="${x}" cy="${y}" r="6.5" fill="#ff9f40"/>`
      : `<circle cx="${x}" cy="${y}" r="4.5" fill="#fff" fill-opacity="0.26"/>`;
  });
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = content;
}
