// The rewriting of LiveKit's signalling while a SOCKS5 proxy is set (packages/core/src/voice-relay.ts),
// in a context of its own, which the native desktop app runs on a thread of its own so that a
// busy core never holds a call up, and the iPhone app beside its core. It needs nothing of the
// host: text and base64 are done here where the engine has neither.
//
// `__zunaRelayFrom(bytes, relayFor)` and `__zunaRelayTo(bytes)` give the message to pass on, or
// a string saying why it's dropped; `relayFor(protocol, address, port)` answers with
// `[address, port]` or null. `__zunaRelayJoin(url)` gives the address to join by, or throws.

import "./relay-text";
import { fromLiveKit, joinAddress, toLiveKit } from "@zuna/core/voice-relay";

const g = globalThis as any;

type Answer = Uint8Array | string;
const answer = (result: ReturnType<typeof toLiveKit>): Answer => ("dropped" in result ? result.dropped : result.message);

g.__zunaRelayFrom = (message: Uint8Array, relayFor: (protocol: string, address: string, port: number) => [string, number] | null): Answer =>
  answer(
    fromLiveKit(message, (candidate) => {
      const relay = relayFor(candidate.protocol, candidate.address, candidate.port);
      return relay ? { address: relay[0], port: relay[1] } : null;
    }),
  );
g.__zunaRelayTo = (message: Uint8Array): Answer => answer(toLiveKit(message));
g.__zunaRelayJoin = (url: string): string => joinAddress(url);
