// Drives the built zuna.chat in real browsers, served as a static host serves it, and checks what the page
// promises: no request leaves its origin, nothing breaks its content security policy, nothing scrolls sideways,
// and it all still reads without script or with less motion. Saves a screenshot of each page at each width.
//
//   npm run build -w @zuna/site && node apps/site/test/site-check.mjs [screenshot-dir] [chromium] [firefox] [webkit] [moz-firefox]
//
// Needs Playwright's browsers: npx playwright-core install chromium firefox webkit
// Playwright's Firefox doesn't start on macOS 27 ("Could not find profile folder"), so moz-firefox runs
// the Firefox installed from Mozilla instead, through WebDriver BiDi.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { HEADERS } from "../policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Build the site first: npm run build -w @zuna/site");

const engines = { chromium, firefox, webkit, "moz-firefox": firefox };
const args = process.argv.slice(2);
const chosen = args.filter((arg) => arg in engines);
const shots = args.find((arg) => !(arg in engines)) ?? mkdtempSync(join(tmpdir(), "zuna-site-"));
mkdirSync(shots, { recursive: true });

const PAGES = ["/", "/privacy/", "/terms/"];
const WIDTHS = [375, 768, 1440];
const failures = [];
let engine = "";
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${engine}: ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(`${engine}: ${name}`);
}

// As the server for zuna.chat does: a folder's index.html, 404.html with a 404 for anything else, and its headers.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain" };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  const found = existsSync(file) && statSync(file).isFile();
  response.writeHead(found ? 200 : 404, { ...HEADERS, "content-type": TYPES[found ? extname(file) : ".html"] ?? "application/octet-stream" });
  response.end(readFileSync(found ? file : join(dist, "404.html")));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

for (const name of chosen.length ? chosen : ["chromium"]) {
  engine = name;
  const browser = await engines[name].launch(name === "moz-firefox" ? { channel: name } : {});
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      for (const path of PAGES) await visit(context, path, width);
      await context.close();
    }
    await interactions(browser);
    await withoutScript(browser);
    await lessMotion(browser);
    await missing(browser);
  } finally {
    await browser.close();
  }
}
server.close();

console.log(`\nScreenshots in ${shots}`);
if (failures.length) {
  console.log(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nAll passed");

/** Opens a page and checks what every page promises. */
async function visit(context, path, width) {
  const page = await context.newPage();
  const { outside, problems } = watch(page);
  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const label = `${path} at ${width}px`;
  check(`${label}: nothing leaves the origin`, outside.length === 0, outside.slice(0, 3).join(", "));
  check(`${label}: no errors or policy violations`, problems.length === 0, problems.slice(0, 3).join(" | "));
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: nothing scrolls sideways`, sideways <= 0, `${sideways}px too wide`);
  const hydrated = await page.evaluate(() => document.getElementById("root")?.dataset.page);
  check(`${label}: prerendered and says which page it is`, Boolean(hydrated), hydrated);
  // Scroll through so every section fades in before the picture is taken.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForTimeout(900);
  const hidden = await page.evaluate(() => [...document.querySelectorAll(".reveal")].filter((element) => getComputedStyle(element).opacity !== "1").length);
  check(`${label}: every section came in`, hidden === 0, `${hidden} still hidden`);
  if (path === "/") {
    const broken = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/#"]')].map((a) => a.getAttribute("href").slice(2)).filter((id) => !document.getElementById(id)),
    );
    check(`${label}: every link into the page has somewhere to go`, broken.length === 0, broken.join(", "));
  }
  const local = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute("href").split("#")[0]))].filter(Boolean));
  for (const href of local) {
    const status = (await fetch(origin + href)).status;
    if (status !== 200) check(`${label}: ${href} is there`, false, String(status));
  }
  await page.screenshot({ path: join(shots, `${engine}-${width}-${path.replace(/\//g, "") || "home"}.png`), fullPage: true });
  await page.close();
}

/** How to host and the download links. */
async function interactions(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { outside, problems } = watch(page);
  await page.goto(origin + "/", { waitUntil: "networkidle" });

  const terminal = page.locator("#host .terminal");
  await terminal.scrollIntoViewIfNeeded();
  await terminal.evaluate(async (element) => {
    const reveal = element.closest(".reveal");
    while (!reveal.classList.contains("is-in")) await new Promise(requestAnimationFrame);
    await Promise.all(reveal.getAnimations().map((animation) => animation.finished));
  });
  const script = (await page.locator("#host .terminal-body").textContent()) ?? "";
  check("the terminal shows the one command", script.includes("curl -fsSL https://zuna.chat/install.sh | sudo sh") && !script.includes("docker"), script);
  check("and its guide is the installer's", (await page.locator("#host .host-guide").getAttribute("href")).endsWith("docs/LINUX.md"));
  const steps = (await page.locator("#host .steps").textContent()) ?? "";
  check("and the steps follow it", steps.includes("Run one command"), steps);
  check("Docker is said to be coming", ((await page.locator("#host .host-soon").textContent()) ?? "").includes("Docker is coming soon"));

  const downloads = await page.locator("#download .platform a.button").evaluateAll((links) => links.map((a) => a.href));
  check("Windows, macOS, Linux and the iPhone each have a download", downloads.length === 4, String(downloads.length));
  check("the desktop's lead to GitHub's releases", downloads.slice(0, 3).every((href) => href.startsWith("https://github.com/zuna-app/zuna/releases")), downloads.join(", "));
  check("and the iPhone's to the App Store", downloads[3]?.startsWith("https://apps.apple.com/app/id") ?? false, downloads.join(", "));
  check("the bar's Download leads to them, not to a file", (await page.locator(".nav-end a.button").getAttribute("href")) === "/#download");

  check("interacting sends nothing anywhere", outside.length === 0, outside.join(", "));
  check("interacting raises no errors", problems.length === 0, problems.join(" | "));
  await page.close();
}

/** Every word is in the HTML, so the page reads with script off. */
async function withoutScript(browser) {
  const { context, close } = await contextWith(browser, { javaScriptEnabled: false, viewport: { width: 1440, height: 900 } }, { "javascript.enabled": false });
  const page = await context.newPage();
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const heading = await page.locator("h1").textContent();
  check("without script, the heading is there", heading === "The chat app nobody owns.", heading ?? "");
  const hidden = await page.evaluate(() => [...document.querySelectorAll(".reveal")].filter((element) => getComputedStyle(element).opacity !== "1").length);
  check("without script, every section shows", hidden === 0, `${hidden} hidden`);
  const answers = await page.locator(".faq-list details").count();
  check("without script, the questions still open", answers >= 8, String(answers));
  const command = await page.locator("#host .terminal-body").evaluate((element) => element.offsetHeight > 0 && element.textContent.includes("install.sh"));
  check("without script, the command to host shows", command);
  await close();
}

/** With less motion asked for, nothing waits to fade in. */
async function lessMotion(browser) {
  const { context, close } = await contextWith(browser, { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } }, { "ui.prefersReducedMotion": 1 });
  const page = await context.newPage();
  await page.goto(origin + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => [...document.querySelectorAll(".reveal")].filter((element) => getComputedStyle(element).opacity !== "1").length);
  check("with less motion, every section shows without scrolling", hidden === 0, `${hidden} hidden`);
  await close();
}

/**
 * A context with script off or less motion asked for. Firefox through WebDriver BiDi ignores both options,
 * so there it's a browser of its own, with Firefox's preferences for them.
 */
async function contextWith(browser, options, prefs) {
  if (engine !== "moz-firefox") {
    const context = await browser.newContext(options);
    return { context, close: () => context.close() };
  }
  const own = await firefox.launch({ channel: engine, firefoxUserPrefs: prefs });
  return { context: await own.newContext(options), close: () => own.close() };
}

async function missing(browser) {
  const page = await browser.newPage();
  const { problems } = watch(page);
  const response = await page.goto(origin + "/no-such-page", { waitUntil: "networkidle" });
  check("a missing page answers 404", response?.status() === 404, String(response?.status()));
  check("and shows the missing page", (await page.locator("h1").textContent()) === "Nothing here but noise.");
  // The browser reports the page's own 404, which is the point.
  const others = problems.filter((problem) => !problem.includes("status of 404"));
  check("and hydrates as the missing page, wherever it's served", others.length === 0, others.join(" | "));
  await page.close();
}

/** Requests to anywhere else, and console errors, which include policy violations and hydration mismatches. */
function watch(page) {
  const outside = [];
  const problems = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) outside.push(url);
  });
  page.on("console", (message) => {
    if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return { outside, problems };
}
