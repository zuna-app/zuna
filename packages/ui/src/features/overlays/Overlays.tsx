import type { Invite } from "@zuna/core";
import { AlertTriangle, BadgeCheck, Copy, Link as LinkIcon, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import { Modal, Spinner, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatUpcoming } from "@/lib/format";
import { t, tx } from "@/lib/i18n";
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
            <button className="icon-btn is-small modal-close" onClick={close} aria-label={t("common.close")}>
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

// In days, or none for never.
const EXPIRY_OPTIONS = [
  { days: 1, seconds: 86_400 },
  { days: 7, seconds: 604_800 },
  { days: 30, seconds: 2_592_000 },
  { days: 0, seconds: 0 },
];
const USE_OPTIONS = [1, 5, 25, 0].map((value) => ({ value }));

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
    toast(t("invites.copied"));
  };

  if (!canManage) {
    return (
      <div className="notice">
        <LinkIcon size={15} />
        <span>{t("invites.adminsOnly")}</span>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field grow">
          <span className="field-label">{t("invites.expiresAfter")}</span>
          <select className="select" value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
            {EXPIRY_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.days ? t("invites.days", { count: option.days }) : t("common.never")}</option>)}
          </select>
        </div>
        <div className="field grow">
          <span className="field-label">{t("invites.canBeUsed")}</span>
          <select className="select" value={uses} onChange={(event) => setUses(Number(event.target.value))}>
            {USE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.value ? t("invites.uses", { count: option.value }) : t("common.noLimit")}</option>)}
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
        {busy ? <Spinner /> : <><LinkIcon size={15} /> {t("invites.create")}</>}
      </button>
      {link && (
        <div className="invite-link">
          <span className="mono truncate selectable">{link}</span>
          <button className="icon-btn is-small" onClick={() => copy(link)} aria-label={t("invites.copyLink")}>
            <Copy size={14} />
          </button>
        </div>
      )}
      {invites && invites.length > 0 && (
        <div className="field">
          <span className="field-label">{t("invites.active")}</span>
          <div className="invite-list">
            {invites.map((invite) => (
              <div key={invite.code} className="invite-row">
                <span className="grow">
                  <span className="mono" style={{ fontSize: 12.5 }}>{invite.code}</span>
                  <span className="faint" style={{ display: "block", fontSize: 11.5 }}>
                    {invite.max_uses ? t("invites.usedOf", { count: invite.uses, max: invite.max_uses }) : t("invites.used", { count: invite.uses })}
                    {invite.expires_at ? ` · ${t("invites.expires", { when: formatUpcoming(invite.expires_at) })}` : ""}
                  </span>
                </span>
                <button
                  className="icon-btn is-small"
                  aria-label={t("invites.copyLink")}
                  onClick={() => void session().linkForInvite(invite.code).then(copy)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="icon-btn is-small"
                  aria-label={t("invites.revoke")}
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
    <Modal title={t("invites.title")} onClose={onClose}>
      <p className="muted" style={{ fontSize: 13.5 }}>{t("invites.warning")}</p>
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
    <Modal title={isSelf ? t("verify.ownTitle") : t("verify.title", { name: user.displayName, username: user.username })} onClose={onClose} width={460}>
      {trust === "changed" && (
        <div className="notice is-danger">
          <ShieldAlert size={16} />
          <span>{tx("verify.changed", { headline: <b>{t("verify.changedHeadline", { name: user.displayName })}</b> })}</span>
        </div>
      )}
      {trust === "verified" && (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>{t("verify.verified", { name: user.displayName })}</span>
        </div>
      )}
      {trust === "unverified" && (
        <p className="muted" style={{ fontSize: 13.5 }}>{t("verify.compare", { name: user.displayName })}</p>
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
              {t("verify.remove")}
            </button>
          ) : (
            <>
              <button
                className="btn grow"
                onClick={() => {
                  toast(t("verify.mismatchToast"), "security");
                  onClose();
                }}
              >
                <AlertTriangle size={15} /> {t("verify.noMatch")}
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
                    toast(t("verify.verifiedToast", { name: user.displayName }));
                    onClose();
                  })
                }
              >
                <BadgeCheck size={16} /> {t("verify.match")}
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
