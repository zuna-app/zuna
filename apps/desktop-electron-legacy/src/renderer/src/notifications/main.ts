// The page in the corner of the screen. It behaves as Telegram's own notifications do
// (notifications_manager_default.cpp in tdesktop): the newest at the bottom, up to three
// at a time with the rest waiting, staying until the person next touches the computer,
// then a few seconds more and a slow fade that the mouse stops.
//
// What it shows came from someone else, so it only ever goes in as text.

import "@fontsource-variable/inter";
import "@/styles/tokens.css";
import "./notifications.css";
import type { NotificationReply, NotificationRoute, NotificationsToClear, NotifyPayload } from "@zuna/ui";

declare global {
  interface Window {
    zunaNotifications: {
      onShow(listener: (payload: NotifyPayload) => void): void;
      onClear(listener: (which: NotificationsToClear) => void): void;
      display(visible: boolean): Promise<void>;
      stack(height: number): Promise<void>;
      typing(on: boolean): Promise<void>;
      open(route: NotificationRoute): Promise<void>;
      reply(reply: NotificationReply): Promise<void>;
      idleSeconds(): Promise<number>;
    };
  }
}

const bridge = window.zunaNotifications;

const MAX_SHOWN = 3;
/** Anyone away for a weekend doesn't need to sit through more than this. */
const MAX_WAITING = 100;
const MAX_REPLY_LENGTH = 100_000;
const GAP = 7;
const FAST_MS = 150;
const SLOW_MS = 4000;
const AFTER_INPUT_MS = 3000;
const CHECK_INPUT_MS = 300;
/** Stays nearly solid for most of the fade, and the mouse has time to catch it. */
const SLOW_EASING = "cubic-bezier(0.6, 0.04, 0.98, 0.335)";

interface Notice {
  payload: NotifyPayload;
  element: HTMLElement;
  started: number;
  height: number;
  waitingForInput: boolean;
  hideTimer: ReturnType<typeof setTimeout> | undefined;
  hiding: boolean;
  /** On its way out, so it takes up no room any more. */
  gone: boolean;
  replying: boolean;
  resizes: ResizeObserver;
}

let waiting: NotifyPayload[] = [];
let shown: Notice[] = [];
let displayed = false;
let typing = false;
let stackHeight = 0;

const hideAll = document.querySelector<HTMLButtonElement>(".hide-all")!;
const template = document.querySelector<HTMLTemplateElement>("#notice")!;
const reducedMotion = () => document.documentElement.dataset.motion === "reduced";

const fades = new WeakMap<Element, Animation>();

function fade(element: HTMLElement, from: number, to: number, duration: number, easing: string, done?: () => void): void {
  fades.get(element)?.cancel();
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration, easing, fill: "both" });
  animation.onfinish = done ?? null;
  fades.set(element, animation);
}

const opacity = (element: HTMLElement) => Number(getComputedStyle(element).opacity);
const place = (element: HTMLElement, shift: number) => {
  element.style.transform = `translateY(${-shift}px)`;
};

// --- Each card ---

function hideSlow(notice: Notice): void {
  if (notice.gone) return;
  notice.hiding = true;
  // With motion reduced it stays solid for as long, and then goes.
  fade(notice.element, 1, 0, SLOW_MS, reducedMotion() ? "steps(1, end)" : SLOW_EASING, () => remove(notice));
}

function hideStop(notice: Notice): void {
  clearTimeout(notice.hideTimer);
  if (!notice.hiding || notice.gone) return;
  notice.hiding = false;
  fade(notice.element, opacity(notice.element), 1, FAST_MS, "linear");
}

function hideFast(notice: Notice): void {
  if (notice.gone) return;
  notice.gone = true;
  notice.hiding = true;
  notice.replying = false;
  clearTimeout(notice.hideTimer);
  notice.element.style.pointerEvents = "none";
  fade(notice.element, opacity(notice.element), 0, FAST_MS, "linear", () => remove(notice));
  updateTyping();
}

function remove(notice: Notice): void {
  const underMouse = notice.element.matches(":hover");
  notice.resizes.disconnect();
  notice.element.remove();
  shown = shown.filter((item) => item !== notice);
  // It left from under the mouse, which nothing else would say.
  if (underMouse) startAllHiding();
  showNext();
}

function dismiss(notice: Notice): void {
  hideFast(notice);
  showNext();
}

/** Opening a chat or replying to it reads it, so the rest of its notifications go too. */
function readChat(route: NotificationRoute): void {
  const same = (payload: NotifyPayload) => payload.route.serverId === route.serverId && payload.route.key === route.key;
  waiting = waiting.filter((payload) => !same(payload));
  for (const notice of shown) if (same(notice.payload)) hideFast(notice);
  showNext();
}

function send(notice: Notice, field: HTMLTextAreaElement): void {
  const text = field.value.trim();
  if (!text) return;
  void bridge.reply({ route: notice.payload.route, messageId: notice.payload.card?.messageId ?? "", text });
  readChat(notice.payload.route);
  startAllHiding();
}

function openReply(notice: Notice, field: HTMLTextAreaElement): void {
  notice.replying = true;
  notice.element.classList.add("replying");
  stopAllHiding();
  updateTyping();
  field.focus();
}

function build(payload: NotifyPayload): Notice {
  const element = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  const find = <T extends Element>(selector: string) => element.querySelector<T>(selector)!;
  const card = payload.card;

  const picture = card?.picture;
  if (!picture) {
    find(".logo").removeAttribute("hidden");
  } else if (picture.image?.startsWith("data:image/")) {
    const image = find<HTMLImageElement>("img");
    image.src = picture.image;
    image.hidden = false;
  } else {
    find(".initials").textContent = picture.initials;
    find<HTMLElement>(".photo").style.background = picture.color;
  }

  find(".name").textContent = payload.title;
  if (card?.kind === "group" && picture) find(".group-icon").removeAttribute("hidden");
  // Who said it, in a group, has its own color.
  const split = card && card.kind !== "dm" ? payload.body.indexOf(": ") : -1;
  find(".author").textContent = split > 0 ? payload.body.slice(0, split + 1) + " " : "";
  find(".body").textContent = split > 0 ? payload.body.slice(split + 2) : payload.body;
  element.classList.toggle("can-reply", !!card?.canReply);

  const notice: Notice = {
    payload,
    element,
    started: Date.now(),
    height: 0,
    waitingForInput: true,
    hideTimer: undefined,
    hiding: false,
    gone: false,
    replying: false,
    // A reply growing pushes the cards above it at once, without a slide that would overlap them.
    resizes: new ResizeObserver(() => {
      if (element.offsetHeight === notice.height) return;
      notice.height = element.offsetHeight;
      document.body.classList.add("no-slide");
      arrange();
      element.getBoundingClientRect();
      document.body.classList.remove("no-slide");
    }),
  };

  const field = find<HTMLTextAreaElement>("textarea");
  field.maxLength = MAX_REPLY_LENGTH;
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss(notice);
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(notice, field);
    }
  });
  find(".reply").addEventListener("click", () => openReply(notice, field));
  find(".close").addEventListener("click", () => dismiss(notice));
  find(".send").addEventListener("mousedown", (event) => event.preventDefault());
  find(".send").addEventListener("click", () => send(notice, field));
  element.addEventListener("mouseenter", stopAllHiding);
  element.addEventListener("mouseleave", startAllHiding);
  element.addEventListener("contextmenu", (event) => event.preventDefault());
  element.addEventListener("mousedown", (event) => {
    const target = event.target as Element;
    // The window takes focus back for anything typed, as it's given up when clicking elsewhere.
    if (target.closest(".reply-area")) {
      if (notice.replying) void bridge.typing(true);
      return;
    }
    if (event.button === 2) {
      dismiss(notice);
    } else if (event.button === 0 && !target.closest("button") && !notice.replying) {
      void bridge.open(payload.route);
      readChat(payload.route);
    }
  });

  document.body.append(element);
  place(element, 0);
  // Measured and in place before it moves, so it rises from the corner.
  notice.height = element.offsetHeight;
  element.getBoundingClientRect();
  fade(element, 0, 1, reducedMotion() ? 0 : FAST_MS, "linear");
  notice.resizes.observe(element);
  return notice;
}

// --- The stack ---

function arrange(): void {
  const live = shown.filter((notice) => !notice.gone);
  let shift = GAP;
  for (const notice of live.toReversed()) {
    place(notice.element, shift);
    shift += notice.element.offsetHeight + GAP;
  }
  let height = live.length > 0 ? shift - GAP : 0;
  if (live.length > 1 || waiting.length > 0) {
    if (hideAll.hidden) {
      hideAll.hidden = false;
      place(hideAll, Math.max(0, shift - GAP - (live[0]?.element.offsetHeight ?? 0)));
      hideAll.getBoundingClientRect();
      fade(hideAll, 0, 1, reducedMotion() ? 0 : FAST_MS, "linear");
    } else {
      fade(hideAll, opacity(hideAll), 1, FAST_MS, "linear");
    }
    place(hideAll, shift);
    height = shift + hideAll.offsetHeight;
  } else if (!hideAll.hidden) {
    fade(hideAll, opacity(hideAll), 0, FAST_MS, "linear", closeHideAll);
  }
  if (height !== stackHeight) {
    stackHeight = height;
    void bridge.stack(height);
  }
}

function closeHideAll(): void {
  hideAll.hidden = true;
  updateDisplay();
}

function showNext(): void {
  let room = MAX_SHOWN - shown.filter((notice) => !notice.gone).length;
  while (room-- > 0 && waiting.length > 0) shown.push(build(waiting.shift()!));
  arrange();
  void checkInput();
  updateDisplay();
}

function startAllHiding(): void {
  if (shown.some((notice) => notice.replying)) return;
  for (const notice of shown) hideSlow(notice);
  if (!hideAll.hidden && waiting.length < 2) {
    fade(hideAll, 1, 0, SLOW_MS, reducedMotion() ? "steps(1, end)" : SLOW_EASING, closeHideAll);
  }
}

function stopAllHiding(): void {
  for (const notice of shown) hideStop(notice);
  if (!hideAll.hidden) fade(hideAll, opacity(hideAll), 1, FAST_MS, "linear");
}

let checking = false;

/** Cards stay until someone is at the computer to see them, and the time they have starts from there. */
async function checkInput(): Promise<void> {
  if (checking) return;
  checking = true;
  while (shown.some((notice) => notice.waitingForInput)) {
    const idle = await bridge.idleSeconds().catch(() => 0);
    // The latest it could have been, since it's only given to the second.
    const lastInput = Date.now() - (idle + 1) * 1000;
    const paused = shown.some((notice) => notice.replying) || !!document.querySelector(".notice:hover");
    for (const notice of shown) {
      if (!notice.waitingForInput) continue;
      if (notice.payload.card?.waitForInput !== false && lastInput <= notice.started) continue;
      notice.waitingForInput = false;
      if (!paused) notice.hideTimer = setTimeout(() => hideSlow(notice), AFTER_INPUT_MS);
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_INPUT_MS));
  }
  checking = false;
}

function updateDisplay(): void {
  const visible = shown.length > 0 || !hideAll.hidden;
  if (visible === displayed) return;
  displayed = visible;
  void bridge.display(visible);
}

function updateTyping(): void {
  const now = shown.some((notice) => notice.replying);
  if (now === typing) return;
  typing = now;
  void bridge.typing(now);
  // The others were waiting for this, and the mouse may have left long ago.
  if (!now && !document.querySelector(".notice:hover")) startAllHiding();
}

hideAll.addEventListener("click", () => {
  waiting = [];
  for (const notice of shown) hideFast(notice);
  showNext();
});

// --- From the app ---

bridge.onShow((payload) => {
  const root = document.documentElement;
  root.dataset.accent = payload.card?.accent ?? "neutral";
  root.dataset.motion = payload.card?.reduceMotion ? "reduced" : "full";
  waiting.push(payload);
  if (waiting.length > MAX_WAITING) waiting.shift();
  // Each one comes back to the top, in case something else went above since.
  displayed = true;
  void bridge.display(true);
  showNext();
});

bridge.onClear((which) => {
  const matches = (payload: NotifyPayload) =>
    (!which.serverId || payload.route.serverId === which.serverId) &&
    (!which.keys || which.keys.includes(payload.route.key)) &&
    (!which.messageId || payload.card?.messageId === which.messageId);
  waiting = waiting.filter((payload) => !matches(payload));
  for (const notice of shown) {
    // Reading a chat elsewhere doesn't take away what's being typed to it.
    if (matches(notice.payload) && !(which.keys && notice.replying)) hideFast(notice);
  }
  showNext();
});
