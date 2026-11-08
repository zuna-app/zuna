// How the core reads files it uploads and hands back files it downloads. The web
// app and the tests use Blobs. The native desktop app and the iOS app pass
// references to files on disk instead, as their JavaScript engines, QuickJS and
// JavaScriptCore, have no Blobs that can hold bytes.

export interface FileAdapter {
  size(source: Blob): number;
  type(source: Blob): string;
  read(source: Blob, start: number, end: number): Promise<Uint8Array>;
  assemble(parts: Uint8Array[], mime: string): Promise<Blob>;
}

export const blobFiles: FileAdapter = {
  size: (source) => source.size,
  type: (source) => source.type,
  read: async (source, start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer()),
  assemble: async (parts, mime) => new Blob(parts as BlobPart[], { type: mime }),
};
