import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as hybrid from "../cli/hybrid.mjs";
import { badPath, checkFiles, indexSigned, makePackage, openPackage, signedPackage, signIndex } from "../cli/package.mjs";
import { readZip } from "../cli/zip.mjs";
import { checkManifest, h, type Manifest } from "../src/index";
import { CLIENT, EVENTS, SESSION, surfaceJson } from "../src/surface";

const vectors = JSON.parse(readFileSync(join(__dirname, "../../../crypto/src/testdata/hybrid-rust.json"), "utf8")).vectors as { kind: number; seed: string; public: string; message: string; signature: string }[];

describe("hybrid signatures", () => {
  it("makes the public key crypto/src/hybrid.rs makes from a lasting key's seed", () => {
    for (const vector of vectors.filter((v) => v.kind === hybrid.LASTING)) {
      const secret = Buffer.concat([Buffer.from([2]), Buffer.from(vector.seed, "hex")]);
      expect(hybrid.publicKey(secret).toString("hex")).toBe(vector.public);
    }
  });

  it("checks the Rust crate's signatures, and the crate's checks would take its own", () => {
    for (const vector of vectors.filter((v) => v.kind === hybrid.LASTING)) {
      const pub = Buffer.from(vector.public, "hex");
      const message = Buffer.from(vector.message, "hex");
      expect(hybrid.verify(pub, message, Buffer.from(vector.signature, "hex"))).toBe(true);
      const secret = Buffer.concat([Buffer.from([2]), Buffer.from(vector.seed, "hex")]);
      const own = hybrid.sign(secret, message);
      expect(own.length).toBe(hybrid.SIGNATURE_LEN);
      expect(hybrid.verify(pub, message, own)).toBe(true);
      expect(hybrid.verify(pub, Buffer.concat([message, Buffer.from([0])]), own)).toBe(false);
    }
  });

  it("refuses a signature one of whose halves is wrong", () => {
    const secret = hybrid.generate();
    const pub = hybrid.publicKey(secret);
    const signature = hybrid.sign(secret, Buffer.from("plugin"));
    for (const at of [10, 200]) {
      const broken = Buffer.from(signature);
      broken[at] ^= 1;
      expect(hybrid.verify(pub, Buffer.from("plugin"), broken)).toBe(false);
    }
  });
});

const manifest: Manifest = {
  manifest: 1,
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  description: "Says hello.",
  author: { name: "Someone" },
  license: "MIT",
  main: "main.js",
  api: 1,
  permissions: ["messages.read", "messages.decorate"],
  contributes: { commands: [{ id: "hello", title: "Hello", slash: "hello" }] },
};

describe("manifests", () => {
  it("takes a good one", () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it("refuses what the app refuses", () => {
    const bad = (change: Record<string, unknown>) => checkManifest({ ...manifest, ...change });
    expect(bad({ id: "Hi" })).not.toEqual([]);
    expect(bad({ api: 2 })).not.toEqual([]);
    expect(bad({ permissions: ["messages.decorate"] })).not.toEqual([]);
    expect(bad({ permissions: ["network"] })).not.toEqual([]);
    expect(bad({ permissions: ["root"] })).not.toEqual([]);
    expect(bad({ hosts: ["api.example.com"] })).not.toEqual([]);
    expect(bad({ extra: true })).not.toEqual([]);
    expect(bad({ main: undefined })).not.toEqual([]);
    expect(checkManifest({ ...manifest, main: undefined, permissions: [], contributes: { themes: [{ id: "dusk", name: "Dusk", colors: { bg0: "#000000" } }] } })).toEqual([]);
    expect(checkManifest({ ...manifest, contributes: { themes: [{ id: "dusk", name: "Dusk", colors: { glow: "#000000" } }] } })).not.toEqual([]);
  });
});

describe("packages", () => {
  const files = new Map<string, Uint8Array>([
    ["plugin.json", Buffer.from(JSON.stringify(manifest))],
    ["main.js", Buffer.from("definePlugin(() => {})")],
    ["assets/icon.svg", Buffer.from("<svg/>")],
  ]);

  it("packs, signs and opens one, and its signature covers every file", () => {
    const secret = hybrid.generate();
    const pub = hybrid.publicKey(secret);
    const zip = makePackage(files, secret);
    const opened = openPackage(zip, [pub]);
    expect(opened.signedBy).not.toBeNull();
    expect([...opened.files.keys()]).toEqual(["plugin.json", "main.js", "assets/icon.svg", "signature"]);
    expect(checkFiles(opened.files).problems).toEqual([]);
    const changed = new Map(opened.files);
    changed.set("main.js", Buffer.from("definePlugin(() => { steal() })"));
    expect(openPackage(makePackage(changed, null), [pub]).signedBy).toBeNull();
    expect(signedPackage(files).toString()).toMatch(/^zuna-plugin-package\/v1\n[0-9a-f]{64} assets\/icon.svg\n/);
  });

  it("makes the same bytes from the same files when unsigned", () => {
    expect(makePackage(files, null).equals(makePackage(files, null))).toBe(true);
    expect([...readZip(makePackage(files, null)).keys()]).toEqual(["plugin.json", "main.js", "assets/icon.svg"]);
  });

  it("refuses paths outside the layout", () => {
    for (const path of ["../x", "assets/../main.js", "assets//x", "src/main.ts", "assets/a b", "/assets/x", "assets\\x"]) expect(badPath(path)).not.toBeNull();
    for (const path of ["plugin.json", "main.js", "signature", "assets/icon.svg", "assets/themes/dusk.json"]) expect(badPath(path)).toBeNull();
  });

  it("signs an index under a label of its own", () => {
    const secret = hybrid.generate();
    const index = Buffer.from(JSON.stringify({ serial: 1, plugins: [] }));
    const sig = signIndex(index, secret);
    expect(indexSigned(index, sig, [hybrid.publicKey(secret)])).toBe(true);
    // The same key's signature on the package label never passes for the index's.
    const asPackage = hybrid.sign(secret, Buffer.concat([Buffer.from("zuna-plugin-package/v1\n"), index])).toString("base64");
    expect(indexSigned(index, asPackage, [hybrid.publicKey(secret)])).toBe(false);
  });
});

describe("views", () => {
  it("makes trees from JSX's calls, flattening children", () => {
    const tree = h("column", { gap: "m" }, h("heading", null, "Stats"), [1, false, "two"], null);
    expect(tree).toEqual({
      type: "column",
      props: { gap: "m" },
      children: [
        { type: "heading", props: {}, children: [{ type: "string", props: { text: "Stats" }, children: [] }] },
        { type: "string", props: { text: "1" }, children: [] },
        { type: "string", props: { text: "two" }, children: [] },
      ],
    });
  });
});

describe("the table", () => {
  it("keeps what the plan says no plugin gets out of reach", () => {
    const never = ["voiceKey", "voiceAccess", "voiceScreenAccess", "changePassword", "regenerateRecoveryKey", "rotate", "deleteAccount", "signOut", "answerNewDevice", "prepareNewDevice", "revokeDevice", "markVerified", "clearVerification", "createBot", "banUser", "exportServerData"] as const;
    for (const method of never) expect(SESSION[method]).toBe("never");
    for (const method of ["login", "register", "recover", "deleteAccount", "leaveServer", "linkPreview", "serverInfo"] as const) expect(CLIENT[method]).toBe("never");
    for (const event of ["voice_key", "security", "new_devices", "button"] as const) expect(EVENTS[event]).toBe("never");
    expect(JSON.parse(surfaceJson()).permissions.length).toBe(15);
  });
});
