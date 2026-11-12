// Just enough of a page for the player's frame to be made and talked to without a browser: a window
// that hands out messages, a document that makes frames, and frames whose posts are recorded, so a
// test can play YouTube's side of the conversation.

type Listener = (event: unknown) => void;

export interface Posted {
  message: Record<string, unknown>;
  target: string;
}

export class FakeWindow {
  readonly posted: Posted[] = [];

  postMessage(data: string, target: string): void {
    this.posted.push({ message: JSON.parse(data), target });
  }

  /** The commands the page sent the player, by name, with their arguments. */
  commands(): [string, unknown[]][] {
    return this.posted.filter((post) => post.message.event === "command").map((post) => [post.message.func as string, post.message.args as unknown[]]);
  }
}

export class FakeFrame {
  className = "";
  title = "";
  allow = "";
  referrerPolicy = "";
  allowFullscreen = false;
  readonly attributes = new Map<string, string>();
  readonly contentWindow = new FakeWindow();
  parent: FakeContainer | null = null;
  private source = "";
  private loadListeners: Listener[] = [];

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    if (name === "src") this.source = "";
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "load") this.loadListeners.push(listener);
  }

  /** The frame finished loading its address. */
  load(): void {
    const listeners = this.loadListeners;
    this.loadListeners = [];
    for (const listener of listeners) listener({});
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

export class FakeContainer {
  children: FakeFrame[] = [];

  append(child: FakeFrame): void {
    child.parent = this;
    this.children.push(child);
  }
}

export interface FakePage {
  window: Record<string, unknown>;
  frames: FakeFrame[];
  player: FakeContainer;
  /** Hands the page a message, as the browser does. */
  message(event: { source: unknown; origin: string; data: unknown }): void;
  listeners(): number;
}

/** Puts a fake page in the globals the player reads, and gives what a test drives it with. */
export function installPage(origin = "https://app.example"): FakePage {
  const frames: FakeFrame[] = [];
  const listeners = new Set<Listener>();
  const player = new FakeContainer();
  const win: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener) => type === "message" && listeners.add(listener),
    removeEventListener: (type: string, listener: Listener) => type === "message" && listeners.delete(listener),
  };
  const doc = {
    createElement: (tag: string) => {
      if (tag !== "iframe") throw new Error(`no ${tag} here`);
      const frame = new FakeFrame();
      frames.push(frame);
      return frame;
    },
    getElementById: (id: string) => (id === "player" ? player : null),
  };
  Object.assign(globalThis, { window: win, document: doc, location: { origin } });
  return {
    window: win,
    frames,
    player,
    message: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listeners: () => listeners.size,
  };
}

/** Takes the fake page away again. */
export function removePage(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals.window;
  delete globals.document;
  delete globals.location;
}
