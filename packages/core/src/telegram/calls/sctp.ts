// The SCTP association a Telegram call's signalling travels in (docs/TELEGRAM_CALLS_PLAN.md, "The
// protocol between the apps"). Telegram's apps put each sealed message through WebRTC's
// SctpTransport, which is Google's dcsctp, over a transport of their own whose every packet is one
// piece of signalling for TDLib to carry: so each piece is one whole SCTP packet, with no DTLS or
// UDP around it, from port 5000 to port 5000, and every message goes ordered and binary on stream 0.
// This is as much of RFC 9260 as that takes, to speak with dcsctp, with the SCTP of Telegram's web
// apps, and with itself. It offers no extension, so the other side sends no FORWARD-TSN, RE-CONFIG
// or I-DATA and no zero checksum; there's one path, no congestion window and no shutdown of its
// own. Nothing in a packet is trusted but to carry the messages, which are sealed above it.

export interface SctpOptions {
  /** One SCTP packet to give the other side. */
  send: (packet: Uint8Array) => void;
  /** One whole message the other side sent, in order. */
  onMessage: (message: Uint8Array) => void;
  /** The association is gone for good: the other side aborted it, or it couldn't be reached after every retransmission. */
  onClosed?: (reason: "aborted" | "lost") => void;
  /** For tests: what to read the time and set timers with. Default Date.now, setTimeout, clearTimeout. */
  clock?: { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Both ends' port, as tgcalls starts its transport. */
const PORT = 5000;
/** The largest message either side sends, as tgcalls starts its transport with. */
const MOST_MESSAGE = 256 * 1024;
/** The common header: the ports, the verification tag and the checksum. */
const HEADER = 12;
/** The most a packet sent from here holds, headers and all: what WebRTC sets dcsctp's MTU to, so that a packet of ours is never larger than one of its own. */
const MOST_PACKET = 1191;
/** A DATA chunk's own header, before its piece of a message. */
const DATA_HEADER = 16;
/** The most of a message one DATA chunk carries, so that one fills a packet, padding and all. */
const MOST_FRAGMENT = (MOST_PACKET - HEADER - DATA_HEADER) & ~3;
/** The largest packet read, as dcsctp reads none bigger than a UDP datagram. */
const MOST_INCOMING = 65535;

const DATA = 0;
const INIT = 1;
const INIT_ACK = 2;
const SACK = 3;
const HEARTBEAT = 4;
const HEARTBEAT_ACK = 5;
const ABORT = 6;
const SHUTDOWN = 7;
const SHUTDOWN_ACK = 8;
const ERROR = 9;
const COOKIE_ECHO = 10;
const COOKIE_ACK = 11;
const SHUTDOWN_COMPLETE = 14;

/** A DATA chunk's flags: the last piece of a message, the first, and a message that's delivered as soon as it's whole. */
const END = 1;
const BEGINNING = 2;
const UNORDERED = 4;
/** An ABORT's or SHUTDOWN-COMPLETE's T bit: it carries the tag of the side that sent it, not the receiver's. */
const REFLECTED = 1;

const HEARTBEAT_INFO = 1;
const STATE_COOKIE = 7;

/** WebRTC's payload protocol identifiers: a binary message, and an empty one, which goes as one byte, since a DATA chunk can't be empty. */
const PPID_BINARY = 53;
const PPID_EMPTY_STRING = 56;
const PPID_EMPTY_BINARY = 57;

/** Streams offered each way, as dcsctp offers them, though only stream 0 is sent on. */
const STREAMS = 65535;
/** The receive window offered, and taken back by what's held here waiting. */
const WINDOW = 256 * 1024;
/**
 * What's held of messages not yet delivered, in bytes and in pieces, past which what comes is
 * dropped unacknowledged, for the other side to send again. The chunk that comes next in sequence
 * is held to a cap twice as high, so that what fills a hole is never what's refused.
 */
const MOST_HELD = 1024 * 1024;
const MOST_HELD_PIECES = 4096;
/** How far past the cumulative ack a TSN may be and still be taken. */
const MOST_AHEAD = 16384;
/** How many gaps a SACK reports, which keeps it to a packet, and how many of the other side's are read. */
const MOST_GAP_BLOCKS = 100;
/** How many State Cookies are remembered, the oldest forgotten first. */
const MOST_COOKIES = 32;

/** T1 sends INIT or COOKIE-ECHO again, from a second, doubling to 8, and gives up after 8 times. */
const T1_FIRST = 1000;
const T1_MOST = 8000;
const MOST_T1_TRIES = 8;
/** T3 sends DATA again, from a second, doubling to 10, and gives up after 10 times with nothing acknowledged. */
const RTO_FIRST = 1000;
const RTO_MOST = 10_000;
const MOST_T3_TRIES = 10;

type State = "closed" | "cookie-wait" | "cookie-echoed" | "established" | "over";

/** What a State Cookie handed out stands for: the association its COOKIE-ECHO would set up. */
interface Cookie {
  handle: Uint8Array;
  local: number;
  localTsn: number;
  peer: number;
  peerTsn: number;
  peerWindow: number;
  /** The tags there were when it was made, or 0, which tell the peer's restart from a stale cookie (RFC 9260 5.2.4). */
  tieLocal: number;
  tiePeer: number;
}

/** A message on its way out: how much of it has gone, and its SSN once its first piece has. */
interface Outgoing {
  data: Uint8Array;
  ppid: number;
  ssn: number;
  offset: number;
}

/** A DATA chunk sent and not yet acknowledged cumulatively. `again` marks it for sending again once it may. */
interface Sent {
  chunk: Uint8Array;
  size: number;
  message: Outgoing;
  acked: boolean;
  again: boolean;
}

/** A piece of a message that came, waiting for the rest of it. */
interface Piece {
  stream: number;
  ssn: number;
  ppid: number;
  flags: number;
  data: Uint8Array;
}

/** A chunk of a packet: its type and flags, and where its value starts and ends. */
interface Chunk {
  type: number;
  flags: number;
  start: number;
  end: number;
}

/** What one packet asks for, gathered as its chunks are read. */
interface Heard {
  replies: Uint8Array[];
  messages: Uint8Array[];
  data: boolean;
  ending: "aborted" | null;
}

const SYSTEM_CLOCK: Required<SctpOptions>["clock"] = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SctpAssociation {
  private readonly clock: Required<SctpOptions>["clock"];
  private state: State = "closed";
  /** This side's tag and first TSN, chosen once for its INIT and any INIT-ACK it answers with before it has an association. */
  private localTag = newTag(0);
  private localTsn = random32();
  private peerTag = 0;
  /** The other side's State Cookie, echoed until its COOKIE-ACK comes. */
  private echo: Uint8Array | null = null;
  private readonly cookies = new Map<string, Cookie>();
  private t1: { handle: unknown } | null = null;
  private t1Tries = 0;
  private t1Delay = T1_FIRST;

  private queue: Outgoing[] = [];
  /** What's been sent and not acknowledged cumulatively, by TSN with none missing: the first is `ackedUpTo + 1`. */
  private flight: Sent[] = [];
  private nextTsn = 0;
  private ackedUpTo = 0;
  private ssn = 0;
  /** What the other side's window has room for, as its last SACK said less what's gone since. */
  private peerWindow = 0;
  private t3: { handle: unknown } | null = null;
  private t3Tries = 0;
  private rto = RTO_FIRST;

  /** The last TSN that came with every one before it. */
  private cumulative = 0;
  /** TSNs past `cumulative` that came, which SACKs report as gaps. */
  private readonly arrived = new Set<number>();
  private readonly pieces = new Map<number, Piece>();
  /** Whole ordered messages waiting for an earlier one, by stream and SSN. */
  private readonly held = new Map<number, Map<number, Uint8Array>>();
  /** The next SSN to deliver, by stream. */
  private readonly expected = new Map<number, number>();
  private heldBytes = 0;
  private heldPieces = 0;

  /** Packets handed back while this was busy, as a host's `send` may hand the answer straight back, read once it's done. */
  private inbox: Uint8Array[] = [];
  private busy = false;
  private stopped = false;

  constructor(private readonly options: SctpOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  get established(): boolean {
    return this.state === "established";
  }

  /** Starts: sends INIT. */
  start(): void {
    if (this.state !== "closed") return;
    this.within(() => {
      this.state = "cookie-wait";
      this.t1Tries = 0;
      this.t1Delay = T1_FIRST;
      this.armT1();
      this.emit(0, [initChunk(INIT, this.localTag, this.localTsn)]);
    });
  }

  /** A packet from the other side. Anything malformed, with a wrong checksum or verification tag, is dropped without throwing. */
  receive(packet: Uint8Array): void {
    if (this.state === "over") return;
    this.inbox.push(packet);
    this.within(() => {});
  }

  /** Sends a message on stream 0, ordered, PPID 53, fragmented as needed; queued until the association is established. Throws if over 256 KiB. */
  send(message: Uint8Array): void {
    if (message.length > MOST_MESSAGE) throw new RangeError("a Telegram call's signalling message is 256 KiB at most");
    if (this.state === "over") return;
    const empty = message.length === 0;
    this.queue.push({ data: empty ? Uint8Array.of(0) : message.slice(), ppid: empty ? PPID_EMPTY_BINARY : PPID_BINARY, ssn: 0, offset: 0 });
    this.within(() => {
      if (this.state === "established") this.flush([]);
    });
  }

  /** Stops every timer and forgets everything. Sends nothing. Further calls do nothing. */
  close(): void {
    this.stopped = true;
    this.finish();
  }

  /**
   * Does `work`, then reads the packets that came meanwhile, one at a time. Called again from
   * inside, as when a host's `send` hands a packet straight back, the work is done at once and the
   * packet waits for the outermost call: so no packet is read halfway through another, or through
   * anything that sends.
   */
  private within(work: () => void): void {
    if (this.busy) return work();
    this.busy = true;
    try {
      work();
      while (this.inbox.length && this.state !== "over") this.process(this.inbox.shift()!);
    } finally {
      this.busy = false;
    }
  }

  private process(packet: Uint8Array): void {
    const heard: Heard = { replies: [], messages: [], data: false, ending: null };
    try {
      this.read(packet, heard);
    } catch (error) {
      // What the checks didn't foresee: the rest of the packet is dropped, as anything malformed is.
      console.warn("[zuna] A packet of a Telegram call's signalling couldn't be read", error);
    }
    if (this.state === "established") this.flush(heard.replies);
    else if (heard.replies.length && this.hasPeer()) this.emit(this.peerTag, heard.replies);
    for (const message of heard.messages) {
      if (this.stopped) return;
      try {
        this.options.onMessage(message);
      } catch (error) {
        console.warn("[zuna] A Telegram call's signalling message couldn't be taken", error);
      }
    }
    if (heard.ending && !this.stopped) this.options.onClosed?.(heard.ending);
  }

  private read(packet: Uint8Array, heard: Heard): void {
    if (packet.length < HEADER || packet.length > MOST_INCOMING) return;
    const view = viewOf(packet);
    if (view.getUint16(0) !== PORT || view.getUint16(2) !== PORT) return;
    // Some implementations leave the checksum 0 when what's below them already protects the packet.
    const checksum = view.getUint32(8, true);
    if (checksum !== 0 && checksum !== checksumOf(packet)) return;
    const chunks = chunksOf(view);
    if (!chunks) return;
    const tag = view.getUint32(4);
    for (let i = 0; i < chunks.length; i++) {
      if (!this.take(packet, view, tag, chunks[i], i, chunks.length, heard)) break;
    }
    if (heard.data && this.hasPeer()) heard.replies.push(this.sackChunk());
  }

  /** One chunk, after its verification tag is checked. False stops the packet there. */
  private take(packet: Uint8Array, view: DataView, tag: number, chunk: Chunk, index: number, count: number, heard: Heard): boolean {
    switch (chunk.type) {
      case INIT:
        // An INIT is alone in its packet, and has no tag yet to carry.
        if (tag === 0 && count === 1) this.heardInit(view, chunk);
        return false;
      case COOKIE_ECHO:
        // It carries the tag the cookie was made with, which may not be this side's yet.
        return index === 0 && this.heardCookieEcho(packet, tag, chunk, heard);
      case ABORT:
      case SHUTDOWN_COMPLETE:
        // This side's tag, or with the T bit the other side's own (RFC 9260 8.5.1).
        if (chunk.flags & REFLECTED ? this.peerTag === 0 || tag !== this.peerTag : tag !== this.localTag) return false;
        // Never expected, as this side never shuts down: a SHUTDOWN-COMPLETE is only dropped.
        if (chunk.type === ABORT) {
          this.finish();
          heard.ending = "aborted";
        }
        return false;
    }
    if (tag !== this.localTag) return false;
    switch (chunk.type) {
      case DATA:
        if (!this.hasPeer()) return true;
        heard.data = true;
        this.heardData(packet, view, chunk, heard);
        return true;
      case INIT_ACK:
        if (this.state === "cookie-wait") this.heardInitAck(packet, view, chunk, heard);
        return true;
      case SACK:
        if (this.hasPeer()) this.heardSack(view, chunk);
        return true;
      case HEARTBEAT: {
        const info = this.hasPeer() ? parameterIn(view, chunk.start, chunk.end, HEARTBEAT_INFO) : null;
        if (info) heard.replies.push(chunkOf(HEARTBEAT_ACK, packet.subarray(info[0], info[1])));
        return true;
      }
      case SHUTDOWN:
      case SHUTDOWN_ACK:
        // The other side is done: what it asked of this packet goes, with the answer, and the association with it.
        if (!this.hasPeer()) return true;
        this.emit(this.peerTag, [...heard.replies, emptyChunk(chunk.type === SHUTDOWN ? SHUTDOWN_ACK : SHUTDOWN_COMPLETE)]);
        this.finish();
        heard.ending = "aborted";
        return false;
      case COOKIE_ACK:
        if (this.state === "cookie-echoed") this.establish();
        return true;
      case HEARTBEAT_ACK:
      case ERROR:
        // This side sends no HEARTBEAT, and what an ERROR reports changes nothing here.
        return true;
    }
    // A chunk this doesn't know: its two high bits say to skip it (1x), or stop at it (0x).
    return (chunk.type & 0x80) !== 0;
  }

  /** An INIT, answered with an INIT-ACK and a cookie for the association it would set up, which changes nothing here until it's echoed. */
  private heardInit(view: DataView, chunk: Chunk): void {
    const init = initOf(view, chunk);
    if (!init) return;
    const peer = { peer: init.tag, peerTsn: init.tsn, peerWindow: init.window };
    let cookie: Omit<Cookie, "handle">;
    if (this.state === "established") {
      // The other side started again: a new tag for a new association, with the present one's as
      // its tie tags (RFC 9260 5.2.2), or the same new tag as for this INIT before.
      const tie = { tieLocal: this.localTag, tiePeer: this.peerTag };
      const before = [...this.cookies.values()].find(
        (kept) => kept.peer === init.tag && kept.peerTsn === init.tsn && kept.tieLocal === tie.tieLocal && kept.tiePeer === tie.tiePeer,
      );
      cookie = before ?? { local: newTag(this.localTag), localTsn: random32(), ...peer, ...tie };
    } else {
      // A collision, or an INIT before this side started: answered with this side's own INIT's tag
      // and TSN (RFC 9260 5.2.1), and once COOKIE-ECHOED, with the association's as tie tags.
      const echoed = this.state === "cookie-echoed";
      cookie = { local: this.localTag, localTsn: this.localTsn, ...peer, tieLocal: echoed ? this.localTag : 0, tiePeer: echoed ? this.peerTag : 0 };
    }
    this.emit(init.tag, [initChunk(INIT_ACK, cookie.local, cookie.localTsn, this.remember(cookie))]);
  }

  /** Keeps a cookie, or finds the same one kept for the same INIT, and gives its handle. */
  private remember(cookie: Omit<Cookie, "handle">): Uint8Array {
    for (const kept of this.cookies.values()) {
      if (kept.local === cookie.local && kept.peer === cookie.peer && kept.peerTsn === cookie.peerTsn && kept.tieLocal === cookie.tieLocal && kept.tiePeer === cookie.tiePeer) return kept.handle;
    }
    const handle = new Uint8Array(8);
    viewOf(handle).setUint32(0, random32());
    viewOf(handle).setUint32(4, random32());
    this.cookies.set(keyOf(handle), { ...cookie, handle });
    if (this.cookies.size > MOST_COOKIES) this.cookies.delete(this.cookies.keys().next().value!);
    return handle;
  }

  private heardInitAck(packet: Uint8Array, view: DataView, chunk: Chunk, heard: Heard): void {
    const init = initOf(view, chunk);
    const cookie = init && parameterIn(view, chunk.start + 16, chunk.end, STATE_COOKIE);
    if (!init || !cookie) return;
    this.peerTag = init.tag;
    this.peerWindow = init.window;
    this.beginSending(this.localTsn);
    this.beginReceiving(init.tsn);
    this.echo = packet.slice(cookie[0] + 4, cookie[1]);
    this.state = "cookie-echoed";
    this.t1Tries = 0;
    this.t1Delay = T1_FIRST;
    this.armT1();
    heard.replies.push(chunkOf(COOKIE_ECHO, this.echo));
  }

  /**
   * A COOKIE-ECHO, by RFC 9260 5.2.4's table: D, the association there is, B, a collision that
   * leaves the other side's tag new, and A, the other side started again, all set up what the
   * cookie says and answer COOKIE-ACK; C, a stale cookie, and anything else are dropped.
   */
  private heardCookieEcho(packet: Uint8Array, tag: number, chunk: Chunk, heard: Heard): boolean {
    const cookie = this.cookies.get(keyOf(packet.subarray(chunk.start, chunk.end)));
    if (!cookie || cookie.local !== tag) return false;
    const localMatches = cookie.local === this.localTag;
    if (this.state === "closed" || this.state === "cookie-wait") {
      if (!localMatches) return false;
      this.adopt(cookie);
    } else {
      const peerMatches = cookie.peer === this.peerTag;
      const tieMatches = cookie.tieLocal === this.localTag && cookie.tiePeer === this.peerTag;
      if (!localMatches && !peerMatches && tieMatches) this.adopt(cookie);
      else if (localMatches && !peerMatches) this.adopt(cookie);
      else if (!(localMatches && peerMatches)) return false;
    }
    if (this.state !== "established") this.establish();
    heard.replies.push(emptyChunk(COOKIE_ACK));
    return true;
  }

  /** Takes up the association a cookie stands for, from its first TSNs both ways. */
  private adopt(cookie: Cookie): void {
    this.localTag = cookie.local;
    this.localTsn = cookie.localTsn;
    this.peerTag = cookie.peer;
    this.peerWindow = cookie.peerWindow;
    this.beginSending(cookie.localTsn);
    this.beginReceiving(cookie.peerTsn);
  }

  private establish(): void {
    this.stopT1();
    this.echo = null;
    this.state = "established";
  }

  /**
   * Sending starts again from a TSN. Whatever a previous association hadn't had acknowledged goes
   * again, whole and in order, as the other side that's there now never got it.
   */
  private beginSending(tsn: number): void {
    const again = new Set<Outgoing>();
    for (const sent of this.flight) if (!sent.acked) again.add(sent.message);
    for (const message of this.queue) again.add(message);
    this.queue = [...again];
    for (const message of this.queue) message.offset = 0;
    this.flight = [];
    this.nextTsn = tsn;
    this.ackedUpTo = (tsn - 1) >>> 0;
    this.ssn = 0;
    this.stopT3();
    this.t3Tries = 0;
    this.rto = RTO_FIRST;
  }

  private beginReceiving(tsn: number): void {
    this.cumulative = (tsn - 1) >>> 0;
    this.arrived.clear();
    this.pieces.clear();
    this.held.clear();
    this.expected.clear();
    this.heldBytes = 0;
    this.heldPieces = 0;
  }

  private heardData(packet: Uint8Array, view: DataView, chunk: Chunk, heard: Heard): void {
    // A DATA chunk with nothing in it isn't allowed.
    if (chunk.end - chunk.start <= DATA_HEADER - 4) return;
    const tsn = view.getUint32(chunk.start);
    const ahead = (tsn - this.cumulative) >>> 0;
    // Behind the cumulative ack, it's a TSN that came before, as is one past it that's arrived.
    if (ahead === 0 || ahead > MOST_AHEAD || this.arrived.has(tsn)) return;
    const data = packet.slice(chunk.start + DATA_HEADER - 4, chunk.end);
    const next = ahead === 1;
    if (this.heldBytes + data.length > (next ? 2 : 1) * MOST_HELD || this.heldPieces >= (next ? 2 : 1) * MOST_HELD_PIECES) return;
    this.arrived.add(tsn);
    while (this.arrived.delete((this.cumulative + 1) >>> 0)) this.cumulative = (this.cumulative + 1) >>> 0;
    const piece: Piece = { stream: view.getUint16(chunk.start + 4), ssn: view.getUint16(chunk.start + 6), ppid: view.getUint32(chunk.start + 8), flags: chunk.flags, data };
    if ((piece.flags & (BEGINNING | END)) === (BEGINNING | END)) return this.whole(piece, data, heard);
    this.pieces.set(tsn, piece);
    this.heldPieces++;
    this.heldBytes += data.length;
    this.assemble(tsn, heard);
  }

  /** Puts a message together, if every piece from its first to its last has come, by TSN. */
  private assemble(tsn: number, heard: Heard): void {
    let first = tsn;
    while (!(this.pieces.get(first)!.flags & BEGINNING)) {
      first = (first - 1) >>> 0;
      if (!this.pieces.has(first)) return;
    }
    let last = tsn;
    while (!(this.pieces.get(last)!.flags & END)) {
      last = (last + 1) >>> 0;
      if (!this.pieces.has(last)) return;
    }
    const head = this.pieces.get(first)!;
    const parts: Uint8Array[] = [];
    let agree = true;
    for (let at = first; ; at = (at + 1) >>> 0) {
      const piece = this.pieces.get(at)!;
      this.pieces.delete(at);
      this.heldPieces--;
      this.heldBytes -= piece.data.length;
      const flags = piece.flags & (BEGINNING | END);
      const expected = (at === first ? BEGINNING : 0) | (at === last ? END : 0);
      if (piece.stream !== head.stream || (piece.flags & UNORDERED) !== (head.flags & UNORDERED) || (!(head.flags & UNORDERED) && piece.ssn !== head.ssn) || flags !== expected) agree = false;
      parts.push(piece.data);
      if (at === last) break;
    }
    // Pieces that don't agree on whose they are make no message, and only a broken peer sends them.
    if (agree) this.whole(head, concat(parts), heard);
  }

  /** A whole message: delivered now if it's unordered or next on its stream, else held for those before it. */
  private whole(piece: Piece, data: Uint8Array, heard: Heard): void {
    const message = piece.ppid === PPID_EMPTY_STRING || piece.ppid === PPID_EMPTY_BINARY ? new Uint8Array(0) : data;
    if (piece.flags & UNORDERED) {
      heard.messages.push(message);
      return;
    }
    let next = this.expected.get(piece.stream) ?? 0;
    const ahead = (piece.ssn - next) & 0xffff;
    if (ahead >= 0x8000) return;
    let waiting = this.held.get(piece.stream);
    if (ahead !== 0) {
      if (!waiting) this.held.set(piece.stream, (waiting = new Map()));
      if (waiting.has(piece.ssn)) return;
      waiting.set(piece.ssn, message);
      this.heldPieces++;
      this.heldBytes += message.length;
      return;
    }
    heard.messages.push(message);
    next = (next + 1) & 0xffff;
    for (let later = waiting?.get(next); waiting && later; later = waiting.get(next)) {
      waiting.delete(next);
      this.heldPieces--;
      this.heldBytes -= later.length;
      heard.messages.push(later);
      next = (next + 1) & 0xffff;
    }
    if (waiting && !waiting.size) this.held.delete(piece.stream);
    this.expected.set(piece.stream, next);
  }

  private sackChunk(): Uint8Array {
    const offsets = Array.from(this.arrived, (tsn) => (tsn - this.cumulative) >>> 0).sort((a, b) => a - b);
    const blocks: [number, number][] = [];
    for (const offset of offsets) {
      const last = blocks[blocks.length - 1];
      if (last && offset === last[1] + 1) last[1] = offset;
      else if (blocks.length < MOST_GAP_BLOCKS) blocks.push([offset, offset]);
      else break;
    }
    const chunk = new Uint8Array(16 + blocks.length * 4);
    const view = viewOf(chunk);
    chunk[0] = SACK;
    view.setUint16(2, chunk.length);
    view.setUint32(4, this.cumulative);
    view.setUint32(8, Math.max(0, WINDOW - this.heldBytes));
    view.setUint16(12, blocks.length);
    blocks.forEach(([from, to], i) => {
      view.setUint16(16 + i * 4, from);
      view.setUint16(18 + i * 4, to);
    });
    return chunk;
  }

  private heardSack(view: DataView, chunk: Chunk): void {
    if (chunk.end - chunk.start < 12) return;
    const cumulative = view.getUint32(chunk.start);
    const gaps = view.getUint16(chunk.start + 8);
    if (chunk.start + 12 + (gaps + view.getUint16(chunk.start + 10)) * 4 > chunk.end) return;
    // Older than the last, or acknowledging what was never sent.
    const acked = (cumulative - this.ackedUpTo) >>> 0;
    if (acked > this.flight.length) return;
    this.flight.splice(0, acked);
    this.ackedUpTo = cumulative;
    // Only so many gaps are read, as many as this side reports: what any others cover is only sent again.
    for (let i = 0; i < Math.min(gaps, MOST_GAP_BLOCKS); i++) {
      // A gap's ends are counted from the cumulative ack, whose next TSN is the first in flight.
      const from = view.getUint16(chunk.start + 12 + i * 4);
      const to = Math.min(view.getUint16(chunk.start + 14 + i * 4), this.flight.length);
      for (let offset = Math.max(from, 1); offset <= to; offset++) this.flight[offset - 1].acked = true;
    }
    let outstanding = 0;
    for (const sent of this.flight) if (!sent.acked) outstanding += sent.size;
    this.peerWindow = view.getUint32(chunk.start + 4) - outstanding;
    if (acked > 0) {
      this.rto = RTO_FIRST;
      this.t3Tries = 0;
    }
    if (outstanding === 0) this.stopT3();
    else if (acked > 0) this.armT3();
  }

  /** Sends `first`, then whatever's marked to go again, then as much that's new as the other side's window has room for. */
  private flush(first: Uint8Array[]): void {
    const chunks = [...first];
    let open = false;
    let data = false;
    for (const sent of this.flight) {
      if (sent.acked) continue;
      open = true;
      if (!sent.again) continue;
      sent.again = false;
      chunks.push(sent.chunk);
      data = true;
    }
    while (this.queue.length) {
      const message = this.queue[0];
      const size = Math.min(MOST_FRAGMENT, message.data.length - message.offset);
      // With nothing in flight, one chunk goes whatever the window says, so a closed window is found open again.
      if (open && this.peerWindow < size) break;
      if (message.offset === 0) {
        message.ssn = this.ssn;
        this.ssn = (this.ssn + 1) & 0xffff;
      }
      const flags = (message.offset === 0 ? BEGINNING : 0) | (message.offset + size === message.data.length ? END : 0);
      const chunk = dataChunk(this.nextTsn, message.ssn, message.ppid, flags, message.data.subarray(message.offset, message.offset + size));
      this.nextTsn = (this.nextTsn + 1) >>> 0;
      this.flight.push({ chunk, size, message, acked: false, again: false });
      chunks.push(chunk);
      data = open = true;
      this.peerWindow -= size;
      message.offset += size;
      if (message.offset === message.data.length) this.queue.shift();
    }
    if (data && !this.t3) this.armT3();
    if (chunks.length) this.emit(this.peerTag, chunks);
  }

  private armT1(): void {
    this.stopT1();
    this.t1 = { handle: this.clock.set(() => this.within(() => this.expiredT1()), this.t1Delay) };
  }

  private stopT1(): void {
    if (this.t1) this.clock.clear(this.t1.handle);
    this.t1 = null;
  }

  private expiredT1(): void {
    this.t1 = null;
    if (this.state !== "cookie-wait" && this.state !== "cookie-echoed") return;
    if (this.t1Tries === MOST_T1_TRIES) return this.lost();
    this.t1Tries++;
    this.t1Delay = Math.min(this.t1Delay * 2, T1_MOST);
    this.armT1();
    if (this.state === "cookie-wait") this.emit(0, [initChunk(INIT, this.localTag, this.localTsn)]);
    else this.emit(this.peerTag, [chunkOf(COOKIE_ECHO, this.echo!)]);
  }

  private armT3(): void {
    this.stopT3();
    this.t3 = { handle: this.clock.set(() => this.within(() => this.expiredT3()), this.rto) };
  }

  private stopT3(): void {
    if (this.t3) this.clock.clear(this.t3.handle);
    this.t3 = null;
  }

  /** Nothing acknowledged in time: everything outstanding is to go again, the oldest packet's worth now and the rest once the other side is heard from. */
  private expiredT3(): void {
    this.t3 = null;
    if (this.state !== "established") return;
    const outstanding = this.flight.filter((sent) => !sent.acked);
    if (!outstanding.length) return;
    if (this.t3Tries === MOST_T3_TRIES) return this.lost();
    this.t3Tries++;
    this.rto = Math.min(this.rto * 2, RTO_MOST);
    const now: Uint8Array[] = [];
    let size = HEADER;
    let full = false;
    for (const sent of outstanding) {
      full ||= now.length > 0 && size + padded(sent.chunk.length) > MOST_PACKET;
      sent.again = full;
      if (full) continue;
      now.push(sent.chunk);
      size += padded(sent.chunk.length);
    }
    this.armT3();
    this.emit(this.peerTag, now);
  }

  private lost(): void {
    this.finish();
    this.options.onClosed?.("lost");
  }

  private hasPeer(): boolean {
    return this.state === "cookie-echoed" || this.state === "established";
  }

  /** The association is over: every timer stops and everything is forgotten. */
  private finish(): void {
    this.state = "over";
    this.stopT1();
    this.stopT3();
    this.peerTag = 0;
    this.echo = null;
    this.cookies.clear();
    this.queue = [];
    this.flight = [];
    this.inbox = [];
    this.beginReceiving(0);
  }

  /** Sends chunks with a verification tag, as few packets as hold them, each at most MOST_PACKET unless one chunk alone is more. */
  private emit(tag: number, chunks: Uint8Array[]): void {
    let group: Uint8Array[] = [];
    let size = HEADER;
    for (const chunk of chunks) {
      if (group.length && size + padded(chunk.length) > MOST_PACKET) {
        this.options.send(packetOf(tag, group, size));
        group = [];
        size = HEADER;
      }
      group.push(chunk);
      size += padded(chunk.length);
    }
    if (group.length) this.options.send(packetOf(tag, group, size));
  }
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A chunk's length with the padding that takes it to a multiple of 4. */
const padded = (length: number): number => (length + 3) & ~3;

const keyOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A random 32-bit number, for tags, TSNs and cookies' handles. They guard nothing secret: the
 * packets travel inside Telegram's own connections between the two accounts, and what they carry
 * is sealed above them. They only tell one association from another.
 */
const random32 = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/** A tag: never 0, which only an INIT carries, nor the one it replaces. */
function newTag(other: number): number {
  for (;;) {
    const tag = random32();
    if (tag !== 0 && tag !== other) return tag;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

/** The chunks of a packet, or null if one runs past its end. The last may leave out its padding. */
function chunksOf(view: DataView): Chunk[] | null {
  const chunks: Chunk[] = [];
  for (let at = HEADER; at + 4 <= view.byteLength; ) {
    const length = view.getUint16(at + 2);
    if (length < 4 || at + length > view.byteLength) return null;
    chunks.push({ type: view.getUint8(at), flags: view.getUint8(at + 1), start: at + 4, end: at + length });
    at += padded(length);
  }
  return chunks;
}

/** Where a parameter of a type is in a chunk's value, its header and all, or null if it isn't there or the parameters run past the end. */
function parameterIn(view: DataView, start: number, end: number, type: number): [number, number] | null {
  for (let at = start; at + 4 <= end; ) {
    const length = view.getUint16(at + 2);
    if (length < 4 || at + length > end) return null;
    if (view.getUint16(at) === type) return [at, at + length];
    at += padded(length);
  }
  return null;
}

/** An INIT's or INIT-ACK's fixed part, or null if it isn't one, with a tag and streams each way. Its other parameters name extensions, which this uses none of. */
function initOf(view: DataView, chunk: Chunk): { tag: number; window: number; tsn: number } | null {
  if (chunk.end - chunk.start < 16) return null;
  const tag = view.getUint32(chunk.start);
  if (tag === 0 || view.getUint16(chunk.start + 8) === 0 || view.getUint16(chunk.start + 10) === 0) return null;
  return { tag, window: view.getUint32(chunk.start + 4), tsn: view.getUint32(chunk.start + 12) };
}

/** An INIT or INIT-ACK, offering no extension, with a State Cookie for an INIT-ACK. */
function initChunk(type: number, tag: number, tsn: number, cookie?: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(20 + (cookie ? 4 + cookie.length : 0));
  const view = viewOf(chunk);
  chunk[0] = type;
  view.setUint16(2, chunk.length);
  view.setUint32(4, tag);
  view.setUint32(8, WINDOW);
  view.setUint16(12, STREAMS);
  view.setUint16(14, STREAMS);
  view.setUint32(16, tsn);
  if (cookie) {
    view.setUint16(20, STATE_COOKIE);
    view.setUint16(22, 4 + cookie.length);
    chunk.set(cookie, 24);
  }
  return chunk;
}

function dataChunk(tsn: number, ssn: number, ppid: number, flags: number, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(DATA_HEADER + data.length);
  const view = viewOf(chunk);
  chunk[0] = DATA;
  chunk[1] = flags;
  view.setUint16(2, chunk.length);
  view.setUint32(4, tsn);
  view.setUint16(10, ssn);
  view.setUint32(12, ppid);
  chunk.set(data, DATA_HEADER);
  return chunk;
}

function chunkOf(type: number, value: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + value.length);
  chunk[0] = type;
  viewOf(chunk).setUint16(2, chunk.length);
  chunk.set(value, 4);
  return chunk;
}

const emptyChunk = (type: number): Uint8Array => Uint8Array.of(type, 0, 0, 4);

function packetOf(tag: number, chunks: Uint8Array[], size: number): Uint8Array {
  const packet = new Uint8Array(size);
  const view = viewOf(packet);
  view.setUint16(0, PORT);
  view.setUint16(2, PORT);
  view.setUint32(4, tag);
  let at = HEADER;
  for (const chunk of chunks) {
    packet.set(chunk, at);
    at += padded(chunk.length);
  }
  // RFC 9260 Appendix B: the CRC32c, taken with the field 0, goes in least significant byte first.
  view.setUint32(8, crc32c(packet), true);
  return packet;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    table[n] = crc;
  }
  return table;
})();

function crcOver(crc: number, bytes: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** CRC32c (Castagnoli), as SCTP's checksum is. */
export function crc32c(bytes: Uint8Array): number {
  return (crcOver(0xffffffff, bytes, 0, bytes.length) ^ 0xffffffff) >>> 0;
}

/** A packet's checksum as it should be: the CRC32c of it with the checksum's own field taken as 0. */
function checksumOf(packet: Uint8Array): number {
  let crc = crcOver(0xffffffff, packet, 0, 8);
  crc = crcOver(crc, ZEROS, 0, 4);
  return (crcOver(crc, packet, HEADER, packet.length) ^ 0xffffffff) >>> 0;
}

const ZEROS = new Uint8Array(4);
