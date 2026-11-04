import { Hash, Trash2, Volume2 } from "lucide-react";
import { useState } from "react";
import { Field, Modal, Spinner, Switch, useAction } from "@/components/ui";
import { useActiveServer, useApp } from "@/state/store";

const AUDIO_QUALITIES = [
  { kbps: 0, label: "Usual (64 kbit/s)" },
  { kbps: 96, label: "Better (96 kbit/s)" },
  { kbps: 128, label: "Great (128 kbit/s)" },
  { kbps: 256, label: "Best (256 kbit/s)" },
];

const SCREEN_LIMITS = [
  { limit: 0, label: "As the server's rules say" },
  { limit: -1, label: "Off in this channel" },
  ...[1, 2, 3, 4, 5, 10].map((limit) => ({ limit, label: limit === 1 ? "One at a time" : `Up to ${limit} at once` })),
];

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
  const { busy, run } = useAction();
  const categories = [...new Set((server?.channels ?? []).map((item) => item.category).filter(Boolean))];
  const finalName = type === "text" ? textChannelName(name).replace(/^-|-$/g, "") : name.trim();
  const voiceReady = !!server?.info?.voice;

  const save = () =>
    run(async () => {
      const details = { name: finalName, topic: topic.trim(), category: category.trim(), bitrate: type === "voice" && bitrate ? bitrate : undefined };
      if (channel) {
        await session().updateChannel(channel.id, { ...details, userLimit: type === "voice" ? userLimit : 0, screenLimit: type === "voice" ? screenLimit : 0, sounds: type === "voice" ? sounds : undefined });
      } else {
        const id = await session().createChannel({ ...details, type, userLimit: type === "voice" ? userLimit : 0, screenLimit: type === "voice" ? screenLimit : 0, sounds: type === "voice" ? sounds : undefined });
        // Opening a voice channel is coming into it, which making one isn't asking for.
        if (type === "text") selectConversation(`group:${id}`);
      }
      onClose();
    });

  const remove = () =>
    run(async () => {
      if (!channel || !window.confirm(`Delete ${channel.name}? Its messages go for everyone.`)) return;
      await session().deleteChannel(channel.id);
      if (server?.activeKey === channel.key) selectConversation(null);
      onClose();
    });

  return (
    <Modal
      title={channel ? "Edit channel" : "New channel"}
      onClose={onClose}
      width={460}
      footer={
        <>
          {channel && (
            <button className="btn btn-danger" disabled={busy} onClick={() => void remove()} style={{ marginRight: "auto" }}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !finalName} onClick={() => void save()}>
            {busy ? <Spinner size={15} /> : channel ? "Save" : "Create channel"}
          </button>
        </>
      }
    >
      {!channel && (
        <div className="field">
          <span className="field-label">Type</span>
          <div className="channel-types">
            <button className={type === "text" ? "is-active" : ""} onClick={() => setType("text")} aria-pressed={type === "text"}>
              <Hash size={18} />
              <span>
                <b>Text</b>
                <span>Messages, pictures and files</span>
              </span>
            </button>
            <button className={type === "voice" ? "is-active" : ""} onClick={() => setType("voice")} aria-pressed={type === "voice"}>
              <Volume2 size={18} />
              <span>
                <b>Voice</b>
                <span>Talk, share a camera or a screen</span>
              </span>
            </button>
          </div>
        </div>
      )}
      {type === "voice" && !voiceReady && <p className="channel-voice-note">This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit (see SELF_HOSTING.md).</p>}
      <Field
        label="Name"
        autoFocus
        maxLength={100}
        value={type === "text" ? textChannelName(name) : name}
        placeholder={type === "text" ? "new-channel" : "Lounge"}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && finalName && !busy) void save();
        }}
      />
      <Field label="Topic" maxLength={1024} value={topic} placeholder="What it's for" onChange={(event) => setTopic(event.target.value)} />
      <Field label="Heading" list="channel-categories" maxLength={100} value={category} placeholder={type === "text" ? "Text channels" : "Voice channels"} onChange={(event) => setCategory(event.target.value)} />
      <datalist id="channel-categories">
        {categories.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      {type === "voice" && (
        <>
          <div className="field">
            <span className="field-label">Audio quality</span>
            <select className="select" value={bitrate} onChange={(event) => setBitrate(Number(event.target.value))}>
              {AUDIO_QUALITIES.map((quality) => (
                <option key={quality.kbps} value={quality.kbps}>
                  {quality.label}
                </option>
              ))}
            </select>
          </div>
          <label className="field">
            <span className="field-label">
              People who fit: <b style={{ fontWeight: 500 }}>{userLimit === 0 ? "no limit" : userLimit}</b>
            </span>
            <input className="voice-slider" type="range" min={0} max={99} value={userLimit} onChange={(event) => setUserLimit(Number(event.target.value))} />
          </label>
          <div className="field">
            <span className="field-label">Screen sharing</span>
            <select className="select" value={screenLimit} onChange={(event) => setScreenLimit(Number(event.target.value))} aria-label="Screen sharing in this channel">
              {[...SCREEN_LIMITS, ...(SCREEN_LIMITS.some((item) => item.limit === screenLimit) ? [] : [{ limit: screenLimit, label: `Up to ${screenLimit} at once` }])].map((item) => (
                <option key={item.limit} value={item.limit}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          {server?.info?.sounds && (
            <div className="field channel-switch">
              <span className="grow">
                <span className="field-label">Soundboard</span>
                <span className="setting-hint">Anyone in the channel can play the server's sounds to everyone there.</span>
              </span>
              <Switch on={sounds} onChange={setSounds} label="Soundboard in this channel" />
            </div>
          )}
        </>
      )}
      <p className="channel-note">
        Everyone on this server can see and join channels. The name and everything said are end-to-end encrypted, so the server can't read them.
      </p>
    </Modal>
  );
}
