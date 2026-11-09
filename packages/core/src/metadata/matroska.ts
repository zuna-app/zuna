// Matroska and WebM films: their tags, title and date written over with Void elements.

import { check, Reader, Output, Patches } from "./bytes";

// --- Matroska and WebM ---

const EBML_SEGMENT = 0x18538067;

const EBML_INFO = 0x1549a966;

const EBML_TAGS = 0x1254c367;

const EBML_DATE = 0x4461;

const EBML_TITLE = 0x7ba9;

interface Element {
  id: number;
  at: number;
  data: number;
  /** Null when the file doesn't say, as for one still being recorded. */
  end: number | null;
}

async function elementAt(reader: Reader, at: number): Promise<Element> {
  const first = await reader.u8(at);
  const idLength = Math.clz32(first) - 23;
  check(idLength >= 1 && idLength <= 4);
  let id = 0;
  for (const byte of await reader.bytes(at, idLength)) id = id * 256 + byte;
  const sizeAt = at + idLength;
  const sizeFirst = await reader.u8(sizeAt);
  const sizeLength = Math.clz32(sizeFirst) - 23;
  check(sizeLength >= 1 && sizeLength <= 8);
  const sizeBytes = await reader.bytes(sizeAt, sizeLength);
  let size = sizeBytes[0]! & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (const byte of sizeBytes.subarray(1)) {
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }
  const data = sizeAt + sizeLength;
  check(unknown || data + size <= reader.size);
  return { id, at, data, end: unknown ? null : data + size };
}

/** An element written over with a Void one of the same length, which readers skip. */
function voidOver(patches: Patches, from: number, to: number): void {
  const length = to - from;
  check(length >= 2);
  let sizeLength = 1;
  while (length - 1 - sizeLength >= 2 ** (7 * sizeLength) - 1) sizeLength++;
  check(sizeLength <= 8);
  const payload = length - 1 - sizeLength;
  const header = new Uint8Array(1 + sizeLength);
  header[0] = 0xec;
  let rest = payload;
  for (let i = sizeLength; i >= 1; i--) {
    header[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  header[1]! |= 0x80 >> (sizeLength - 1);
  patches.write(from, header);
  patches.zero(from + header.length, payload);
}

/** Tags, which hold dates, places and programs, and the file's title and when it was made, become Void. */
export async function matroska(reader: Reader): Promise<Output> {
  const patches = new Patches();
  let at = 0;
  while (at < reader.size) {
    const element = await elementAt(reader, at);
    if (element.id === EBML_SEGMENT) {
      const end = element.end ?? reader.size;
      let child = element.data;
      while (child < end) {
        const inner = await elementAt(reader, child);
        // Past a cluster of unknown length, as a recording has, nothing more can be found without reading the film.
        if (inner.end === null) break;
        check(inner.end <= end);
        if (inner.id === EBML_TAGS) voidOver(patches, inner.at, inner.end);
        else if (inner.id === EBML_INFO) {
          for (let field = inner.data; field < inner.end; ) {
            const item = await elementAt(reader, field);
            check(item.end !== null && item.end <= inner.end);
            if (item.id === EBML_DATE || item.id === EBML_TITLE) voidOver(patches, item.at, item.end);
            field = item.end;
          }
        }
        child = inner.end;
      }
      break;
    }
    check(element.end !== null);
    at = element.end;
  }
  return patches.output(reader.size);
}
