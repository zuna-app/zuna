// The core's own words follow the language the app gives it (`ZunaClient.setLanguage`): its
// errors, the server's messages, what a notification says and the emoji people compare. With no
// catalog it's English, as for zuna-bot.

import english from "@zuna/i18n/locales/en.json";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { safetyEmoji } from "../src/crypto";
import { useCatalog } from "../src/i18n";
import { notificationText, previewText } from "../src/notify";
import { loadCrypto, TestApp, TestServer } from "./helpers";

const taken = english["server.thatUsernameIsAlreadyTaken"];

const polish = {
  $language: "Polski",
  $plural: { one: "i = 1 and v = 0", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14", many: "v = 0 and i != 1 and i % 10 = 0..1 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 12..14" },
  "notify.photo": "📷 Zdjęcie",
  "notify.senderAndText": "{sender}: {text}",
  "notify.group": "Grupa",
  "safety.dog": "Pies",
  "errors.aChannelNeedsAName": "Kanał musi mieć nazwę.",
  "server.thatUsernameIsAlreadyTaken": "Ta nazwa użytkownika jest już zajęta.",
};

beforeAll(() => loadCrypto());

const photo = { text: "", attachments: [{ mime: "image/jpeg" }] } as unknown as Parameters<typeof previewText>[0];

describe("the core's words", () => {
  afterEach(() => useCatalog("en", null));

  it("are English without a catalog", () => {
    expect(previewText(photo)).toBe("📷 Photo");
    expect(notificationText("group", undefined, "Ada", photo)).toEqual({ title: "Group", body: "Ada: 📷 Photo" });
  });

  it("are the catalog's, with English for what it leaves out", () => {
    useCatalog("pl", polish);
    expect(previewText(photo)).toBe("📷 Zdjęcie");
    expect(notificationText("group", undefined, "Ada", photo)).toEqual({ title: "Grupa", body: "Ada: 📷 Zdjęcie" });
    expect(previewText({ ...photo, attachments: [{ mime: "audio/ogg" }] } as never)).toBe(english["notify.audio"]);
  });

  it("name the emoji people compare in the catalog's language, which changes nothing they compare", () => {
    const own = new Uint8Array(32).fill(1);
    const theirs = new Uint8Array(32).fill(2);
    const before = safetyEmoji(own, theirs);
    useCatalog("pl", polish);
    const after = safetyEmoji(own, theirs);
    expect(after.map((item) => item.emoji)).toEqual(before.map((item) => item.emoji));
    for (const [i, item] of after.entries()) expect(item.name).toBe(item.emoji === "🐶" ? "Pies" : before[i]!.name);
  });

  it("refuse a catalog that's malformed and keep the language they had", () => {
    useCatalog("pl", polish);
    expect(() => useCatalog("pl", { $plural: {} })).toThrow();
    expect(previewText(photo)).toBe("📷 Zdjęcie");
  });
});

describe("through the client", () => {
  const server = new TestServer();
  let ada: TestApp;
  let bob: TestApp;

  beforeAll(async () => {
    ada = new TestApp("ada");
    bob = new TestApp("bob");
    await server.start();
    await ada.open();
    await bob.open();
    await ada.register(server.setupLink, "ada");
  });

  afterAll(async () => {
    ada.client.stop();
    bob.client.stop();
    useCatalog("en", null);
    await server.stop();
  });

  it("puts the core's errors and the server's messages in the language it's given", async () => {
    const invite = await ada.session.createInvite(2, 3600);
    const preview = await bob.client.previewInvite(invite);
    await expect(bob.client.register(preview, "ada", "correct horse battery", { displayName: "Ada" })).rejects.toThrow(taken);
    bob.client.setLanguage("pl", polish);
    await expect(bob.client.register(preview, "ada", "correct horse battery", { displayName: "Ada" })).rejects.toThrow("Ta nazwa użytkownika jest już zajęta.");
    await expect(ada.session.createChannel({ type: "text", name: " " })).rejects.toThrow("Kanał musi mieć nazwę.");
    bob.client.setLanguage("en", null);
    await expect(ada.session.createChannel({ type: "text", name: " " })).rejects.toThrow(english["errors.aChannelNeedsAName"]);
  });
});
