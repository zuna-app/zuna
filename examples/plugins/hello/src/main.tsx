import { definePlugin, h } from "@zuna/plugin";

// A plugin that shows each kind of thing a plugin can do, which the checks install.
export default definePlugin((zuna) => {
  zuna.commands.on("hello", ({ composer }) => composer.insert(zuna.settings.get<string>("greeting") || "Hello!"));
  zuna.commands.on("shrug", ({ composer, args }) => composer.insert(`${args ? `${args} ` : ""}¯\\_(ツ)_/¯`));

  // Counts the messages it's told of while it runs, kept in its own storage.
  zuna.messages.on((_message, isNew) => {
    if (isNew) void zuna.storage.set("seen", (zuna.storage.get<number>("seen") ?? 0) + 1);
  });

  // A small mark on messages that say hello.
  zuna.messages.decorate((message) => {
    if (!zuna.settings.get<boolean>("mark")) return null;
    return /\b(hello|hi|hey)\b/i.test(message.text) ? { mark: { icon: "sparkles", label: "Hello" } } : null;
  });

  const stats = (state: Readonly<Record<string, unknown>>) => (
    <column gap="m">
      <heading>Messages seen</heading>
      <text size="xl" weight="bold">{String(state.seen ?? 0)}</text>
      <text color="text2">Since this plugin started counting, on every server this device is on.</text>
      <row gap="s">
        <button kind="primary" onClick={() => zuna.storage.set("seen", 0)}>Reset</button>
        <button onClick={() => zuna.ui.toast("Still here.")}>Say something</button>
      </row>
    </column>
  );

  zuna.ui.panel("stats", { title: "Hello", icon: "sparkles", render: stats });
  zuna.ui.page("stats", { title: "Hello", icon: "sparkles", render: stats });
  zuna.ui.headerButton("stats", { icon: "sparkles", title: "Messages seen", onClick: () => zuna.ui.openPanel("stats") });
  zuna.ui.messageAction("quote", {
    label: "Say hello back",
    icon: "sparkles",
    onClick: () => zuna.ui.dialog({
      title: "Hello back",
      render: () => (
        <column gap="m">
          <text>Pressing a plugin's entry lets it open a dialog for a moment, as this one did.</text>
          <button kind="primary" onClick={() => zuna.ui.closeDialog()}>Close</button>
        </column>
      ),
    }),
  });
});
