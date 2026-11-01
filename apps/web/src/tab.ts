// Zuna runs in one tab at a time, as Telegram's and WhatsApp's web apps do. Its
// database can only be open once, and two cores on one device would compete.
// The tab running it holds a Web Lock. Another tab offers "Use here", which asks
// the first to stop over a BroadcastChannel and then takes the lock.

const LOCK = "zuna-core";
const TAKE = "zuna-take";
const channel = new BroadcastChannel("zuna-tabs");

/** Runs the app whenever this tab may, and shows why it can't otherwise. `start` returns how to stop it. */
export function holdTab(start: () => () => void): void {
  let taking = false;
  try {
    taking = sessionStorage.getItem(TAKE) === "1";
    sessionStorage.removeItem(TAKE);
  } catch {
    // Without session storage, "Use here" just waits its turn.
  }
  if (taking) {
    channel.postMessage("take");
    void navigator.locks.request(LOCK, () => run(start));
  } else {
    void navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? run(start) : showElsewhere()));
  }
}

function run(start: () => () => void): Promise<void> {
  const stop = start();
  return new Promise((release) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== "take") return;
      channel.removeEventListener("message", onMessage);
      stop();
      showElsewhere();
      release();
    };
    channel.addEventListener("message", onMessage);
  });
}

/** Shows a screen in place of the app, with one button. */
export function showScreen(title: string, text: string, action?: { label: string; run: () => void }): void {
  const screen = document.getElementById("tab-screen")!;
  const card = document.createElement("div");
  card.className = "empty-state tab-screen-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  card.append(heading, paragraph);
  if (action) {
    const button = document.createElement("button");
    button.className = "btn btn-primary";
    button.textContent = action.label;
    button.onclick = action.run;
    card.append(button);
  }
  screen.replaceChildren(card);
  screen.hidden = false;
}

function showElsewhere(): void {
  showScreen("Zuna is open in another tab", "It runs in one tab at a time. Using it here closes it there.", {
    label: "Use here",
    run() {
      // A fresh page starts the app cleanly, and asks the other tab to stop as it loads.
      try {
        sessionStorage.setItem(TAKE, "1");
      } catch {
        // It'll wait for the other tab to close instead.
      }
      location.reload();
    },
  });
}
