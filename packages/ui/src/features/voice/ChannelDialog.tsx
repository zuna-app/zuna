import { SLOW_MODE_TIMES } from "@zuna/core";
import { Hash, Trash2, Volume2 } from "lucide-react";
import { useState } from "react";
import { Confirm, Field, Modal, Spinner, Switch, useAction } from "@/components/ui";
import { timerText } from "@/lib/disappearing";
import { mark, t, tx, type MessageKey } from "@/lib/i18n";
import { useActiveServer, useApp } from "@/state/store";

const AUDIO_QUALITIES: { kbps: number; label: MessageKey }[] = [
  { kbps: 0, label: mark("channels.audio.standard") },
  { kbps: 96, label: mark("channels.audio.better") },
  { kbps: 128, label: mark("channels.audio.great") },
  { kbps: 256, label: mark("channels.audio.best") },
];

const SCREEN_LIMITS = [0, -1, 1, 2, 3, 4, 5, 10];

/** What a limit on screen shares is called: the server's, none at all, or how many at once. */
const screenLimitName = (limit: number): string =>
  limit === 0 ? t("channels.dialog.screenDefault") : limit === -1 ? t("common.off") : limit === 1 ? t("channels.dialog.screenOne") : t("channels.screen.upTo", { count: limit });

/** Text channels go by lowercase names with dashes, as in Discord, which also keeps them easy to mention. */
const textChannelName = (name: string): string => name.toLowerCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-");

/** Making a channel, or changing one, for a server admin. */
export function ChannelDialog({ channelId, channelType, onClose }: { channelId?: string; channelType?: "text" | "voice"; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const selectConversation = useApp((state) => state.selectConversation);
  const channel = channelId ? server?.channels.find((item) => item.id === channelId) : undefined;
  const [type, setType] = useState<"text" | "voice">(channel?.type ?? channelType ?? "text");
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [category, setCategory] = useState(channel?.category ?? "");
  const [userLimit, setUserLimit] = useState(channel?.userLimit ?? 0);
  const [bitrate, setBitrate] = useState(channel?.bitrate ?? 0);
  const [screenLimit, setScreenLimit] = useState(channel?.screenLimit ?? 0);
  const [sounds, setSounds] = useState(channel?.sounds ?? true);
  const [watch, setWatch] = useState(channel?.watch ?? true);
  const [adminOnly, setAdminOnly] = useState(channel?.adminOnly ?? false);
  const [slowOn, setSlowOn] = useState((channel?.slowMode ?? 0) > 0);
  const [slowMode, setSlowMode] = useState(channel?.slowMode || 30);
  const [deleting, setDeleting] = useState(false);
  const { busy, run } = useAction();
  const categories = [...new Set((server?.channels ?? []).map((item) => item.category).filter(Boolean))];
  const finalName = type === "text" ? textChannelName(name).replace(/^-|-$/g, "") : name.trim();
  const voiceReady = !!server?.info?.voice;

  const save = () =>
    run(async () => {
      const details = { name: finalName, topic: topic.trim(), category: category.trim(), bitrate: type === "voice" && bitrate ? bitrate : undefined };
      if (channel) {
        await session().updateChannel(channel.id, { ...details, userLimit: type === "voice" ? userLimit : 0, screenLimit: type === "voice" ? screenLimit : 0, sounds: type === "voice" ? sounds : undefined, watch: type === "voice" ? watch : undefined, adminOnly, slowMode: slowOn ? slowMode : 0 });
      } else {
        const id = await session().createChannel({ ...details, type, userLimit: type === "voice" ? userLimit : 0, screenLimit: type === "voice" ? screenLimit : 0, sounds: type === "voice" ? sounds : undefined, watch: type === "voice" ? watch : undefined, adminOnly, slowMode: slowOn ? slowMode : 0 });
        // Opening a voice channel is coming into it, which making one isn't asking for.
        if (type === "text") selectConversation(`group:${id}`);
      }
      onClose();
    });

  const remove = () =>
    run(async () => {
      if (!channel) return;
      await session().deleteChannel(channel.id);
      if (server?.activeKey === channel.key) selectConversation(null);
      onClose();
    });

  return (
    <Modal
      title={channel ? t("channels.edit") : t("channels.new")}
      onClose={onClose}
      width={460}
      footer={
        <>
          {channel && (
            <button className="btn btn-danger" disabled={busy} onClick={() => setDeleting(true)} style={{ marginRight: "auto" }}>
              <Trash2 size={14} /> {t("common.delete")}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || !finalName} onClick={() => void save()}>
            {busy ? <Spinner size={15} /> : channel ? t("common.save") : t("channels.form.create")}
          </button>
        </>
      }
    >
      {!channel && (
        <div className="field">
          <span className="field-label">{t("channels.form.type")}</span>
          <div className="channel-types">
            <button className={type === "text" ? "is-active" : ""} onClick={() => setType("text")} aria-pressed={type === "text"}>
              <Hash size={18} />
              <span>
                <b>{t("channels.form.text")}</b>
                <span>{t("channels.form.textHint")}</span>
              </span>
            </button>
            <button className={type === "voice" ? "is-active" : ""} onClick={() => setType("voice")} aria-pressed={type === "voice"}>
              <Volume2 size={18} />
              <span>
                <b>{t("channels.form.voice")}</b>
                <span>{t("channels.form.voiceHint")}</span>
              </span>
            </button>
          </div>
        </div>
      )}
      {type === "voice" && !voiceReady && <p className="channel-voice-note">{t("channels.noMediaServer")}</p>}
      <Field
        label={t("common.name")}
        autoFocus
        maxLength={100}
        value={type === "text" ? textChannelName(name) : name}
        placeholder={type === "text" ? t("channels.dialog.textPlaceholder") : t("channels.dialog.voicePlaceholder")}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && finalName && !busy) void save();
        }}
      />
      <Field label={t("channels.form.topic")} maxLength={1024} value={topic} placeholder={t("channels.form.topicPlaceholder")} onChange={(event) => setTopic(event.target.value)} />
      <Field label={t("channels.form.heading")} list="channel-categories" maxLength={100} value={category} placeholder={type === "text" ? t("channels.textChannels") : t("channels.voiceChannels")} onChange={(event) => setCategory(event.target.value)} />
      <datalist id="channel-categories">
        {categories.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <div className="field channel-switch">
        <span className="grow">
          <span className="field-label">{t("channels.adminsOnly")}</span>
          <span className="setting-hint">{adminOnly && channel && !channel.adminOnly ? t("channels.editor.adminOnlyNow") : t("channels.form.adminOnlyHint")}</span>
        </span>
        <Switch on={adminOnly} onChange={setAdminOnly} label={t("channels.adminsOnly")} />
      </div>
      <div className="field channel-switch">
        <span className="grow">
          <span className="field-label">{t("channels.form.slowMode")}</span>
          <span className="setting-hint">{t("channels.form.slowModeHint")}</span>
        </span>
        <Switch on={slowOn} onChange={setSlowOn} label={t("channels.form.slowMode")} />
      </div>
      {slowOn && (
        <div className="field">
          <span className="field-label">{t("channels.form.slowModeTime")}</span>
          <select className="select" value={slowMode} onChange={(event) => setSlowMode(Number(event.target.value))} aria-label={t("channels.form.slowModeTime")}>
            {[...SLOW_MODE_TIMES, ...(SLOW_MODE_TIMES.includes(slowMode) ? [] : [slowMode])].map((seconds) => (
              <option key={seconds} value={seconds}>
                {timerText(seconds)}
              </option>
            ))}
          </select>
        </div>
      )}
      {type === "voice" && (
        <>
          <div className="field">
            <span className="field-label">{t("channels.form.audioQuality")}</span>
            <select className="select" value={bitrate} onChange={(event) => setBitrate(Number(event.target.value))}>
              {AUDIO_QUALITIES.map((quality) => (
                <option key={quality.kbps} value={quality.kbps}>
                  {t(quality.label)}
                </option>
              ))}
            </select>
          </div>
          <label className="field">
            <span className="field-label">{tx("channels.dialog.maxPeople", { value: <b style={{ fontWeight: 500 }}>{userLimit === 0 ? t("channels.form.noLimit") : userLimit}</b> })}</span>
            <input className="voice-slider" type="range" min={0} max={99} value={userLimit} onChange={(event) => setUserLimit(Number(event.target.value))} />
          </label>
          <div className="field">
            <span className="field-label">{t("channels.form.screenSharing")}</span>
            <select className="select" value={screenLimit} onChange={(event) => setScreenLimit(Number(event.target.value))} aria-label={t("channels.dialog.screenSharingLabel")}>
              {[...SCREEN_LIMITS, ...(SCREEN_LIMITS.includes(screenLimit) ? [] : [screenLimit])].map((limit) => (
                <option key={limit} value={limit}>
                  {screenLimitName(limit)}
                </option>
              ))}
            </select>
          </div>
          <div className="field channel-switch">
            <span className="grow">
              <span className="field-label">{t("channels.form.soundboard")}</span>
              <span className="setting-hint">{t("channels.form.soundboardHint")}</span>
            </span>
            <Switch on={sounds} onChange={setSounds} label={t("channels.dialog.soundboardLabel")} />
          </div>
          <div className="field channel-switch">
            <span className="grow">
              <span className="field-label">{t("channels.form.watch")}</span>
              <span className="setting-hint">{t("channels.form.watchHint")}</span>
            </span>
            <Switch on={watch} onChange={setWatch} label={t("channels.dialog.watchLabel")} />
          </div>
        </>
      )}
      <p className="channel-note">
        {adminOnly ? t("channels.dialog.noteAdmins") : t("channels.dialog.noteEveryone")} {t("channels.dialog.noteEncrypted")}
      </p>
      {deleting && channel && (
        <Confirm
          title={t("channels.deleteTitle", { name: channel.name })}
          action={t("common.delete")}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void remove();
          }}
        >
          {t("channels.delete.text")}
        </Confirm>
      )}
    </Modal>
  );
}
