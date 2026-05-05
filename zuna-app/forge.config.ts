import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import 'dotenv/config';
import path from 'path';
import os from 'os';
import fs from 'fs';

const keyPath = path.join(os.tmpdir(), 'AuthKey.p8');
if (process.env.APPLE_API_KEY_BASE64) {
  fs.writeFileSync(
    keyPath,
    Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64')
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "./public/icon",
    extraResource: ["./public/zuna.png"],
    osxSign: {
      identity: "Developer ID Application: Mikolaj Galazka (SGKB9R23YT)",
    },
    osxNotarize: {
      appleApiIssuer: process.env.APPLE_API_ISSUER_ID as string,
      appleApiKey: keyPath,
      appleApiKeyId: process.env.APPLE_API_KEY_ID as string,
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      setupIcon: "./public/icon.ico",
    }),
    new MakerZIP({}, ["linux", "darwin"]),
    new MakerDeb({
      options: {
        icon: "./public/zuna.png",
      },
    }),
    new MakerRpm({
      options: {
        icon: "./public/zuna.png",
      },
    }),
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@forkprince/electron-forge-maker-appimage",
      platforms: ["linux"],
      config: {
        productName: "Zuna",
        icons: [
          {
            file: "./public/zuna.png",
            size: 256,
          },
        ],
      },
    },
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
        {
          name: "notification_host_window",
          config: "vite.notification.config.ts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
