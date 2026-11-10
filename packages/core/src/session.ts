// A live session with one server: everything between the UI and the network.
//
// The rule that keeps this reliable: all MLS operations on a group run one at a
// time under that group's lock, and commits are only applied in server order.
// Any device whose state can't be repaired by that simply rejoins the group
// with an external commit, so a bad state never ends a conversation.
//
// ServerSession is written in parts, in session/, each a class that extends the one
// before it. base.ts lists them, and holds the state they share.

import { SessionLifecycle } from "./session/lifecycle";

export { rotationTiming, tokenTiming, voiceTiming } from "./session/shared";

export class ServerSession extends SessionLifecycle {}
