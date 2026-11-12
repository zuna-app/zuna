// @zuna/plugin: what a plugin for Zuna's native app is written with.
//
//   import { definePlugin, h } from "@zuna/plugin";
//
//   export default definePlugin((zuna) => {
//     zuna.commands.on("shrug", ({ composer }) => composer.insert("¯\\_(ツ)_/¯"));
//   });
//
// The API itself is the app's: definePlugin hands the setup to it, and the app calls it with
// the API, so a plugin built with an older SDK still gets the API of the app it runs in.
// This package is under the MIT license, so that a plugin which bundles it, and uses only
// the plugin API, isn't bound by the app's AGPL.

import type { Zuna } from "./api.ts";

export * from "./api.ts";
export * from "./manifest.ts";
export { Fragment, h, type Child, type Color, type IconName, type NodeType, type Nodes, type Render, type Shape, type Space, type ViewNode } from "./view.ts";

export type Setup = (zuna: Zuna) => void | Promise<void>;

declare global {
  // eslint-disable-next-line no-var
  var __zunaDefine: ((setup: Setup) => void) | undefined;
}

/** Declares the plugin: the app runs `setup` once, as the plugin starts. */
export function definePlugin(setup: Setup): Setup {
  globalThis.__zunaDefine?.(setup);
  return setup;
}
