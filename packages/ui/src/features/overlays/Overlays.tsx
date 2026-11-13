import type { Invite } from "@zuna/core";
import { AlertTriangle, BadgeCheck, Copy, Link as LinkIcon, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import { Modal, Spinner, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatUpcoming } from "@/lib/format";
import { useActiveServer, useApp } from "@/state/store";
import { JoinFlow } from "@/features/onboarding/Onboarding";
import { ChannelDialog } from "@/features/voice/ChannelDialog";
import { ServerSettings } from "./ServerSettings";
import { ShareLocation } from "./ShareLocation";
import { Settings } from "./Settings";
import { ImageViewer } from "./ImageViewer";
import { ForwardPicker, NewGroup, AddMembers } from "./GroupDialogs";

export function Overlays() {
  const overlay = useApp((state) => state.overlay);
  const setOverlay = useApp((state) => state.setOverlay);
  const close = () => setOverlay(null);
  return (
    <AnimatePresence>
      {overlay?.type === "add-server" && (
        <Modal key="add-server" onClose={close} width={420} bare>
          <div className="modal-flow">
            <button className="icon-btn is-small modal-close" onClick={close} aria-label="Close">
              <X size={17} />
            </button>
            <JoinFlow initialLink={overlay.link} initialSignInUrl={overlay.signInUrl} onDone={close} embedded />
          </div>
        </Modal>
      )}
      {overlay?.type === "settings" && <Settings key="settings" initialSection={overlay.section} onClose={close} />}
      {overlay?.type === "server-settings" && <ServerSettings key="server-settings" initialSection={overlay.section} onClose={close} />}
      {overlay?.type === "new-group" && <NewGroup key="new-group" onClose={close} />}
      {overlay?.type === "invite" && <InvitePeople key="invite" onClose={close} />}
      {overlay?.type === "verify" && <VerifyIdentity key="verify" userId={overlay.userId} onClose={close} />}
      {overlay?.type === "add-members" && <AddMembers key="add-members" groupId={overlay.groupId} onClose={close} />}
      {overlay?.type === "image" && <ImageViewer key="image" serverId={overlay.serverId} pictures={overlay.pictures} start={overlay.index} onClose={close} />}
      {overlay?.type === "forward" && <ForwardPicker key="forward" serverId={overlay.serverId} groupId={overlay.groupId} ids={overlay.ids} onClose={close} />}
      {overlay?.type === "share-location" && <ShareLocation key="share-location" conversationKey={overlay.conversationKey} onClose={close} />}
      {overlay?.type === "channel" && <ChannelDialog key="channel" channelId={overlay.channelId} channelType={overlay.channelType} onClose={close} />}
    </AnimatePresence>
  );
}

const EXPIRY_OPTIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
  { label: "Never", seconds: 0 },
];
const USE_OPTIONS = [
  { label: "1 use", value: 1 },
  { label: "5 uses", value: 5 },
  { label: "25 uses", value: 25 },
  { label: "No limit", value: 0 },
];

export function InvitePanel() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { busy, run } = useAction();
  const [expiry, setExpiry] = useState(EXPIRY_OPTIONS[1]!.seconds);
  const [uses, setUses] = useState(USE_OPTIONS[3]!.value);
  const [link, setLink] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const canManage = server?.self?.role !== "member" || server?.info?.allow_member_invites;

  const refresh = () => {
    if (!canManage) return;
    void session().invites().then(setInvites).catch(() => setInvites([]));
  };
  useEffect(refresh, [canManage, session]);

  const copy = async (value: string) => {
    await copyText(value);
    toast("Invite link copied");
  };

  if (!canManage) {
    return (
      <div className="notice">
        <LinkIcon size={15} />
        <span>On this server, only admins can create invite links. Ask one of them for a link.</span>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field grow">
          <span className="field-label">Expires after</span>
          <select className="select" value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
            {EXPIRY_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
          </select>
        </div>
        <div className="field grow">
          <span className="field-label">Can be used</span>
          <select className="select" value={uses} onChange={(event) => setUses(Number(event.target.value))}>
            {USE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const created = await session().createInvite(uses, expiry);
            setLink(created);
            await copy(created).catch(() => undefined);
            refresh();
          })
        }
      >
        {busy ? <Spinner /> : <><LinkIcon size={15} /> Create invite link</>}
      </button>
      {link && (
        <div className="invite-link">
          <span className="mono truncate selectable">{link}</span>
          <button className="icon-btn is-small" onClick={() => copy(link)} aria-label="Copy link">
            <Copy size={14} />
          </button>
        </div>
      )}
      {invites && invites.length > 0 && (
        <div className="field">
          <span className="field-label">Active links</span>
          <div className="invite-list">
            {invites.map((invite) => (
              <div key={invite.code} className="invite-row">
                <span className="grow">
                  <span className="mono" style={{ fontSize: 12.5 }}>{invite.code}</span>
                  <span className="faint" style={{ display: "block", fontSize: 11.5 }}>
                    {invite.uses} used{invite.max_uses ? ` of ${invite.max_uses}` : ""}
                    {invite.expires_at ? ` · expires ${formatUpcoming(invite.expires_at)}` : ""}
                  </span>
                </span>
                <button
                  className="icon-btn is-small"
                  aria-label="Copy link"
                  onClick={() => void session().linkForInvite(invite.code).then(copy)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="icon-btn is-small"
                  aria-label="Revoke link"
                  onClick={() => run(async () => {
                    await session().revokeInvite(invite.code);
                    refresh();
                  })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InvitePeople({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Invite people" onClose={onClose}>
      <p className="muted" style={{ fontSize: 13.5 }}>
        Anyone with a link can create an account here. It also holds the key that protects member profiles, so only share it with people you trust.
      </p>
      <InvitePanel />
    </Modal>
  );
}

function VerifyIdentity({ userId, onClose }: { userId: string; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { run } = useAction();
  const [check, setCheck] = useState<Awaited<ReturnType<ReturnType<typeof session>["safetyCheck"]>>>(null);
  const user = server?.users[userId];

  useEffect(() => {
    void session().safetyCheck(userId).then(setCheck);
  }, [userId, session, user?.trust]);

  if (!user) return null;
  const isSelf = userId === server?.self?.userId;
  const trust = check?.trust ?? user.trust;

  return (
    <Modal title={isSelf ? "Your security key" : `Verify ${user.displayName} (@${user.username})`} onClose={onClose} width={460}>
      {trust === "changed" && (
        <div className="notice is-danger">
          <ShieldAlert size={16} />
          <span>
            <b>{user.displayName}'s security key changed</b> in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.
          </span>
        </div>
      )}
      {trust === "verified" && (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>You've verified {user.displayName}. Nobody can secretly intercept your messages.</span>
        </div>
      )}
      {trust === "unverified" && (
        <p className="muted" style={{ fontSize: 13.5 }}>
          Compare these emoji with {user.displayName} in person or on a call. If they match exactly, nobody else, not even this server, can read your conversation.
        </p>
      )}
      <div className="safety-grid">
        {check?.emoji.map((item, index) => (
          <div className="safety-cell" key={index}>
            <span className="safety-emoji">{item.emoji}</span>
            <span className="safety-name">{item.name}</span>
          </div>
        ))}
      </div>
      {!isSelf && (
        <div className="row">
          {trust === "verified" ? (
            <button className="btn grow" onClick={() => run(async () => { await session().clearVerification(userId); })}>
              Remove verification
            </button>
          ) : (
            <>
              <button
                className="btn grow"
                onClick={() => {
                  toast("Don't share anything private with them until you know why the emoji differ.", "security");
                  onClose();
                }}
              >
                <AlertTriangle size={15} /> They don't match
              </button>
              <button
                className="btn btn-primary grow"
                disabled={!check}
                onClick={() =>
                  run(async () => {
                    if (!check) return;
                    try {
                      await session().markVerified(userId, check.covers);
                    } catch (error) {
                      // Whatever changed, these are no longer the emoji to compare.
                      void session().safetyCheck(userId).then(setCheck);
                      throw error;
                    }
                    toast(`${user.displayName} is verified`);
                    onClose();
                  })
                }
              >
                <BadgeCheck size={16} /> They match
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
