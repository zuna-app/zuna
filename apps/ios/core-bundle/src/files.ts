// Files for the core on iOS. The app hands the core references to files on
// disk; the host reads them a chunk at a time, and writes downloaded files to
// a protected cache, so large files never have to fit in JavaScript memory.
// In-memory blobs (from tests) still work.

import type { FileAdapter } from "@zuna/core";
import { BlobPolyfill } from "./polyfills";

/** A file on disk, by absolute path. */
export class NativeFile {
  constructor(
    readonly path: string,
    readonly type: string,
  ) {}

  get size(): number {
    return __zunaHost.fileSize(this.path);
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

const asNative = (source: unknown) => source as NativeFile | BlobPolyfill;

export const nativeFiles: FileAdapter = {
  size: (source) => asNative(source).size,
  type: (source) => asNative(source).type,
  async read(source, start, end) {
    const file = asNative(source);
    if (file instanceof NativeFile) return __zunaHost.fileRead(file.path, start, end);
    return file.raw.slice(start, end);
  },
  async assemble(parts, mime) {
    const path = __zunaHost.fileAssemble(parts, EXTENSIONS[mime] ?? "bin");
    return new NativeFile(path, mime) as unknown as Blob;
  },
};
