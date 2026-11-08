// Whether a message could have been sent by the device it names, from what this device saw
// of the group's tree. The session decides by this before it shows a message as someone's,
// and a phone's notification preview (push.ts) before it words one as theirs, so the two
// can't drift apart.

/**
 * What this device recorded about a sender's device in a group, each asked for only when it's
 * needed, and null where there's no record. Each is sealed to its row (`sealedRows`), and one
 * that doesn't open reads the most careful way.
 */
export interface SenderRecord {
  /** The epoch that device left the tree, if it did. */
  left(): number | null;
  /** The epoch this device came into the group at, if it did. */
  joined(): number | null;
  /** The epoch the sender's device came into the tree, as this device saw it. */
  arrived(): number | null;
  /** The server's sequence number the epoch after the message's started at, if it has. */
  nextStart(): number | null;
}

export function couldBeSent(record: SenderRecord, message: { epoch: number; seq: number }): boolean {
  const left = record.left();
  if (left !== null && message.epoch >= left) return false;
  // Under an epoch this device was there for, only a device that was in the tree then can have sent it.
  const joined = record.joined();
  if (joined !== null && message.epoch >= joined) {
    const arrived = record.arrived();
    if (arrived === null || message.epoch < arrived) return false;
  }
  const next = record.nextStart();
  return next === null || message.seq < next;
}

/** The names and rows each of those is sealed under, and what one that doesn't open counts as. */
export const sealedRows = {
  departure: { name: "departure", row: (groupId: string, userId: string, deviceId: string) => `${groupId}/${userId}/${deviceId}`, careful: 0 },
  arrival: { name: "arrival", row: (groupId: string, userId: string, deviceId: string) => `${groupId}/${userId}/${deviceId}`, careful: Number.MAX_SAFE_INTEGER },
  joined: { name: "joined", row: (groupId: string) => groupId, careful: 0 },
  epochStart: { name: "epoch-start", row: (groupId: string, epoch: number) => `${groupId}:${epoch}`, careful: 0 },
} as const;
