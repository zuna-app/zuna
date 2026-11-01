// Calls from the UI thread into the client core, which runs in a Worker so that
// cryptography and the database can never block scrolling or animation.

import type { ZunaClient } from "./client";
import type { ServerSession } from "./session";
import type { CoreEvent } from "./types";

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export type RemoteClient = Remote<ZunaClient>;
export type RemoteSession = Remote<ServerSession>;

export interface CoreConnection {
  client: RemoteClient;
  session(serverId: string): RemoteSession;
}

interface CallMessage {
  kind: "call";
  id: number;
  serverId: string | null;
  method: string;
  args: unknown[];
}

interface ReplyMessage {
  kind: "reply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; code?: string; status?: number };
}

interface EventMessage {
  kind: "event";
  event: CoreEvent;
}

export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** Each public method of `T` by name: what TypeScript lets the interface call. */
type MethodName<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] & string;

// What the interface may call. A list, rather than whatever name arrives, keeps the
// core's private methods, such as those that save keys, out of reach of a page
// someone has taken over. TypeScript checks that each is exactly the public methods.
const CLIENT_METHODS: Record<MethodName<ZunaClient>, true> = {
  findLink: true, forwardMessages: true, leaveServer: true, linkPreview: true, listServers: true, login: true, nudge: true, open: true,
  previewInvite: true, recover: true, register: true, reorderServers: true, resume: true, serverInfo: true, session: true, setActive: true,
  stop: true, suspend: true
};
const SESSION_METHODS: Record<MethodName<ServerSession>, true> = {
  addMembers: true, banUser: true, changePassword: true, clearVerification: true, createChannel: true, createGroup: true, createInvite: true, deleteChannel: true, deleteGroup: true,
  deleteMessage: true, deleteMessages: true, discardMessage: true, downloadFile: true, editMessage: true, emoteUrl: true, emotesIn: true,
  flushOutbox: true, forgetConversation: true, forwardMessage: true, forwardable: true, getChannels: true, getConnectionState: true, getConversations: true,
  getDevices: true, getEmotes: true, getInfo: true, getPreferences: true, getSelf: true, getUsers: true, getVoiceMembers: true, invites: true,
  isActiveElsewhere: true, leaveGroup: true, linkForInvite: true, loadAround: true, loadMedia: true, loadMessages: true, loadPins: true, markChatRead: true, markRead: true,
  markMentionSeen: true, markVerified: true, mediaCounts: true, messageById: true, mute: true, nudge: true, prepareNewDevice: true, previewText: true, refreshEmotes: true,
  regenerateRecoveryKey: true, removeMember: true, reorderChannels: true, resume: true, retryMessage: true, revokeDevice: true, revokeInvite: true, rotate: true,
  safetyCheck: true, search: true, searchCoverage: true, sendMessage: true, sendTyping: true, sendWithAttachments: true, serverUrl: true,
  setActive: true, setBlocked: true, setDisappearing: true, setEmoteSet: true, setGroupRole: true, setHideLastSeen: true, setMarkedUnread: true, setMentionsOnly: true, setPinned: true, setPush: true, setServerRole: true, setVoiceState: true,
  signOut: true, start: true, stop: true, suspend: true, syncGroup: true, toggleReaction: true, unbanUser: true, unmute: true, unreadMentions: true,
  updateChannel: true, updateGroupMeta: true, updatePreferences: true, updateProfile: true, updateServerIcon: true, updateServerSettings: true,
  voiceAccess: true, voiceDisconnect: true, voiceKey: true, voiceMute: true, voiceScreenAccess: true,
};

/** Runs in the worker: answers calls by invoking methods on the client or a session. */
export function serveCore(port: RpcPort, getClient: () => ZunaClient | Promise<ZunaClient>): (event: CoreEvent) => void {
  port.onmessage = async ({ data }: MessageEvent) => {
    const call = data as CallMessage;
    if (call.kind !== "call") return;
    try {
      if (typeof call.method !== "string" || !Object.hasOwn(call.serverId ? SESSION_METHODS : CLIENT_METHODS, call.method)) {
        throw new Error("The core has no such thing to do.");
      }
      const client = await getClient();
      const target: any = call.serverId ? client.session(call.serverId) : client;
      const value = await target[call.method](...call.args);
      port.postMessage({ kind: "reply", id: call.id, ok: true, value } satisfies ReplyMessage);
    } catch (error) {
      const failure = error as Error & { code?: string; status?: number };
      port.postMessage({
        kind: "reply",
        id: call.id,
        ok: false,
        error: { name: failure.name, message: failure.message ?? String(error), code: failure.code, status: failure.status },
      } satisfies ReplyMessage);
    }
  };
  return (event) => port.postMessage({ kind: "event", event } satisfies EventMessage);
}

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/** Runs on the UI thread: gives typed, promise-returning proxies of the core. */
export function connectCore(port: RpcPort, onEvent: (event: CoreEvent) => void): CoreConnection {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  port.onmessage = ({ data }: MessageEvent) => {
    const message = data as ReplyMessage | EventMessage;
    if (message.kind === "event") {
      onEvent(message.event);
    } else if (message.kind === "reply") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.value);
      } else {
        entry.reject(new CoreError(message.error?.message ?? "Something went wrong.", message.error?.code, message.error?.status));
      }
    }
  };

  const proxyFor = <T>(serverId: string | null): T =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          (...args: unknown[]) =>
            new Promise((resolve, reject) => {
              const id = nextId++;
              pending.set(id, { resolve, reject });
              port.postMessage({ kind: "call", id, serverId, method, args } satisfies CallMessage);
            }),
      },
    ) as T;

  const sessions = new Map<string, RemoteSession>();
  return {
    client: proxyFor<RemoteClient>(null),
    session(serverId) {
      let session = sessions.get(serverId);
      if (!session) {
        session = proxyFor<RemoteSession>(serverId);
        sessions.set(serverId, session);
      }
      return session;
    },
  };
}
