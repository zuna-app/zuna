import type { ScreenRules } from "@zuna/core";
import { DEFAULT_SCREEN_RULES, screenTerms } from "@zuna/core/voice";
import { useEffect, useState } from "react";
import { Field, Spinner, Switch, useAction } from "@/components/ui";
import { SettingRow } from "@/features/overlays/Settings";
import { platform } from "@/platform";
import { useActiveServer, useApp } from "@/state/store";
import { bitrateName, heightName, rateName, SCREEN_BITRATES, SCREEN_HEIGHTS, SCREEN_RATES, SCREEN_SOUND_BITRATES, screenLimitsText, type ScreenCodec, type ScreenContent, type ScreenEffort, type ScreenEncoder, type ScreenPriority } from "@/voice/settings";
import { useVoice } from "@/voice/store";

/**
 * A choice among numbers, with those a server's limit rules out shown as unavailable. Extras
 * go first, such as leaving it to the server, and a value set some other way stays in the list.
 */
export function NumberSelect({
  label,
  value,
  options,
  name,
  extras = [],
  limit = 0,
  hint,
  onChange,
}: {
  label: string;
  value: number | null;
  options: number[];
  name: (value: number) => string;
  extras?: { value: number | null; label: string }[];
  limit?: number;
  hint?: string;
  onChange: (value: number | null) => void;
}) {
  const known = options.includes(value as number) || extras.some((extra) => extra.value === value);
  const shown = known || value === null ? options : [...options, value];
  const key = (item: number | null) => (item === null ? "" : String(item));
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="select" value={key(value)} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}>
        {extras.map((extra) => (
          <option key={key(extra.value)} value={key(extra.value)}>
            {extra.label}
          </option>
        ))}
        {shown.map((option) => (
          <option key={option} value={option} disabled={limit > 0 && option > limit}>
            {name(option)}
          </option>
        ))}
      </select>
      {hint && <span className="setting-hint">{hint}</span>}
    </label>
  );
}

function Segmented<Value extends string>({ value, options, onChange, label }: { value: Value; options: { id: Value; label: string }[]; onChange: (value: Value) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} className={value === option.id ? "is-active" : ""} onClick={() => onChange(option.id)} aria-pressed={value === option.id}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

const CONTENTS: { id: ScreenContent; label: string }[] = [
  { id: "detail", label: "Detail" },
  { id: "text", label: "Text" },
  { id: "motion", label: "Motion" },
];
const PRIORITIES: { id: ScreenPriority; label: string }[] = [
  { id: "sharp", label: "Keep it sharp" },
  { id: "balanced", label: "Balance" },
  { id: "smooth", label: "Keep it smooth" },
];
const EFFORTS: { id: ScreenEffort; label: string }[] = [
  { id: "speed", label: "Fastest" },
  { id: "balanced", label: "Balanced" },
  { id: "best", label: "Best picture" },
];
const CODECS: { id: ScreenCodec; label: string }[] = [
  { id: "auto", label: "Automatic" },
  { id: "h264", label: "H.264" },
  { id: "vp8", label: "VP8" },
  { id: "vp9", label: "VP9" },
];

/** How this device shares a screen and watches others', within what its server allows. */
export function ScreenSettingsSection() {
  const settings = useVoice((state) => state.settings);
  const update = useVoice((state) => state.updateSettings);
  const callServerId = useVoice((state) => state.serverId);
  const callServer = useApp((state) => (callServerId ? state.servers[callServerId] : undefined));
  const active = useActiveServer();
  const server = callServer ?? active;
  const rules = server?.info?.screen_share;
  const role = server?.self?.role;
  const shown = rules ?? DEFAULT_SCREEN_RULES;
  const exempt = shown.admins_exempt && (role === "owner" || role === "admin");
  const limit = (value: number) => (exempt ? 0 : value);
  const terms = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: settings.screenBitrate, soundKbps: settings.screenSoundKbps }, rules, role);
  const suggested = screenTerms({ height: null, fps: null, kbps: null, soundKbps: settings.screenSoundKbps }, rules, role);
  const limits = screenLimitsText(rules, role);
  const native = platform.nativeScreen;

  return (
    <>
      <h1>Screen sharing</h1>
      <p className="settings-lead">These are for this device. Whatever you share is encrypted before it leaves it.</p>
      {limits && <p className="screen-held">{limits}</p>}

      <h3 className="settings-subhead">Picture</h3>
      <NumberSelect
        label="Size"
        value={settings.screenHeight}
        options={[0, ...SCREEN_HEIGHTS]}
        name={heightName}
        extras={[{ value: null, label: `Server's choice (${heightName(suggested.height)})` }]}
        limit={limit(shown.max_height)}
        hint={terms.held.includes("height") ? `Sent at up to ${heightName(terms.height)}, which is this server's limit.` : "A larger screen is made smaller to fit, keeping its shape."}
        onChange={(value) => update({ screenHeight: value })}
      />
      <NumberSelect
        label="Frame rate"
        value={settings.screenFps}
        options={SCREEN_RATES}
        name={rateName}
        extras={[{ value: null, label: `Server's choice (${rateName(suggested.fps)})` }]}
        limit={limit(shown.max_fps)}
        hint={terms.held.includes("fps") ? `Sent at ${rateName(terms.fps)}, which is this server's limit.` : undefined}
        onChange={(value) => update({ screenFps: value })}
      />
      <NumberSelect
        label="Most it may send"
        value={settings.screenBitrate}
        options={SCREEN_BITRATES}
        name={bitrateName}
        extras={[{ value: null, label: `Server's choice (${bitrateName(suggested.kbps)})` }]}
        limit={limit(shown.max_kbps)}
        hint={terms.held.includes("kbps") ? `Sent at up to ${bitrateName(terms.kbps)}, which is this server's limit.` : "It sends less when your connection or the screen doesn't need that much."}
        onChange={(value) => update({ screenBitrate: value })}
      />

      {platform.systemAudio && (
        <>
          <h3 className="settings-subhead">Sound</h3>
          {shown.sound ? (
            <>
              <SettingRow title="Start with sound on" hint="Everything your computer plays, apart from this call. You can still turn it off each time.">
                <Switch on={settings.screenSound} onChange={(value) => update({ screenSound: value })} label="Start with sound on" />
              </SettingRow>
              <NumberSelect
                label="Sound quality"
                value={settings.screenSoundKbps}
                options={SCREEN_SOUND_BITRATES}
                name={bitrateName}
                limit={limit(shown.max_sound_kbps)}
                onChange={(value) => update({ screenSoundKbps: value ?? 128 })}
              />
            </>
          ) : (
            <p className="screen-held">This server doesn't let sound go with a share.</p>
          )}
        </>
      )}

      {native && (
        <>
          <h3 className="settings-subhead">On your graphics card</h3>
          <SettingRow title="Capture whole screens on your graphics card" hint="Much lighter on your computer, and it stays smooth at high frame rates. Windows always go through the browser.">
            <Switch on={settings.screenNative} onChange={(value) => update({ screenNative: value })} label="Capture whole screens on your graphics card" />
          </SettingRow>
          {settings.screenNative && (
            <>
              <SettingRow title="Show your pointer" hint="Whatever goes through the browser always shows it.">
                <Switch on={settings.screenCursor} onChange={(value) => update({ screenCursor: value })} label="Show your pointer" />
              </SettingRow>
              <label className="field">
                <span className="field-label">Encoder</span>
                <select className="select" value={settings.screenEncoder} onChange={(event) => update({ screenEncoder: event.target.value as ScreenEncoder })}>
                  <option value="auto">Automatic: the card driving the screen</option>
                  {native.encoders.map((encoder) => (
                    <option key={encoder.id} value={encoder.id}>
                      {encoder.name}
                    </option>
                  ))}
                </select>
                <span className="setting-hint">If this one can't be used, your share goes through the browser instead, and Stream stats says why.</span>
              </label>
              <SettingRow title="Effort per frame" hint="More effort looks better at the same bitrate, and can drop frames at large sizes.">
                <Segmented value={settings.screenEffort} options={EFFORTS} onChange={(value) => update({ screenEffort: value })} label="Effort per frame" />
              </SettingRow>
              <label className="field">
                <span className="field-label">
                  A full picture every <b style={{ fontWeight: 500 }}>{settings.screenKeyframes} s</b>
                </span>
                <input className="voice-slider" type="range" min={1} max={30} step={1} value={settings.screenKeyframes} onChange={(event) => update({ screenKeyframes: Number(event.target.value) })} />
                <span className="setting-hint">Sooner helps anyone who joins or loses packets, and costs some sharpness.</span>
              </label>
            </>
          )}
        </>
      )}

      <h3 className="settings-subhead">{native ? "Through the browser" : "Encoding"}</h3>
      <p className="screen-held">{native ? "For windows, or whenever a screen can't be captured on your graphics card." : "Your browser captures and encodes what you share."}</p>
      <SettingRow title="Mostly showing" hint="Text and detail stay crisp, and motion stays fluid.">
        <Segmented value={settings.screenContent} options={CONTENTS} onChange={(value) => update({ screenContent: value })} label="Mostly showing" />
      </SettingRow>
      <SettingRow title="When the connection can't keep up">
        <Segmented value={settings.screenPriority} options={PRIORITIES} onChange={(value) => update({ screenPriority: value })} label="When the connection can't keep up" />
      </SettingRow>
      <SettingRow title="Codec" hint="Whoever's watching has to be able to play it. H.264 and VP8 play everywhere.">
        <select className="select" style={{ width: "auto" }} value={settings.screenCodec} onChange={(event) => update({ screenCodec: event.target.value as ScreenCodec })} aria-label="Codec">
          {CODECS.map((codec) => (
            <option key={codec.id} value={codec.id}>
              {codec.label}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Also send a smaller copy" hint="For those on a slow connection, at the cost of more work and more upload. Not with VP9.">
        <Switch on={settings.screenLayers} onChange={(value) => update({ screenLayers: value })} label="Also send a smaller copy" />
      </SettingRow>

      <h3 className="settings-subhead">Watching</h3>
      <SettingRow title="Open a share when it starts" hint="A screen someone starts sharing fills the stage, unless you're already looking at something.">
        <Switch on={settings.screenFocus} onChange={(value) => update({ screenFocus: value })} label="Open a share when it starts" />
      </SettingRow>
      <label className="field">
        <span className="field-label">
          How loud shares are <b style={{ fontWeight: 500 }}>{Math.round(settings.screenVolume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={settings.screenVolume} onChange={(event) => update({ screenVolume: Number(event.target.value) })} />
      </label>
    </>
  );
}

/** What this server allows and suggests for sharing a screen, for its admins. */
export function ServerScreenSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { busy, run } = useAction();
  const [rules, setRules] = useState<ScreenRules>(server?.info?.screen_share ?? DEFAULT_SCREEN_RULES);
  useEffect(() => {
    if (server?.info?.screen_share) setRules(server.info.screen_share);
  }, [server?.info?.screen_share]);
  const change = (changes: Partial<ScreenRules>) => setRules((current) => ({ ...current, ...changes }));
  const count = (value: string) => Math.max(0, Math.floor(Number(value) || 0));

  /** What's suggested can't be more than what's allowed. */
  const fitted = (): ScreenRules => ({
    ...rules,
    default_height: rules.max_height > 0 && rules.default_height > rules.max_height ? rules.max_height : rules.default_height,
    default_fps: rules.max_fps > 0 ? Math.min(rules.default_fps, rules.max_fps) : rules.default_fps,
    default_kbps: rules.max_kbps > 0 ? Math.min(rules.default_kbps, rules.max_kbps) : rules.default_kbps,
  });

  return (
    <>
      <h1>Screen sharing</h1>
      <p className="settings-lead">What people on this server can share. It's all encrypted, so the server never sees what's on anyone's screen.</p>
      {!server?.info?.voice && <p className="channel-voice-note">This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit (see SELF_HOSTING.md).</p>}

      <h3 className="settings-subhead">Who and how many</h3>
      <SettingRow title="Who can share" hint="Changing this stops any share it no longer allows.">
        <Segmented
          value={rules.who}
          options={[
            { id: "everyone", label: "Everyone" },
            { id: "admins", label: "Admins" },
            { id: "nobody", label: "Nobody" },
          ]}
          onChange={(who) => change({ who })}
          label="Who can share"
        />
      </SettingRow>
      <SettingRow title="Let sound go with a share" hint="Turning this off stops any share that has sound.">
        <Switch on={rules.sound} onChange={(sound) => change({ sound })} label="Let sound go with a share" />
      </SettingRow>
      <Field label="Shares at once in a voice channel" type="number" min={0} max={99} value={String(rules.max_per_channel)} hint="0 is no limit. Each channel can say otherwise when you edit it." onChange={(event) => change({ max_per_channel: count(event.target.value) })} />
      <Field label="Shares at once on this server" type="number" min={0} max={1000} value={String(rules.max_per_server)} hint="0 is no limit." onChange={(event) => change({ max_per_server: count(event.target.value) })} />
      <p className="screen-held">The media server enforces all of these, whichever app someone uses.</p>

      <h3 className="settings-subhead">Limits</h3>
      <NumberSelect label="Largest picture" value={rules.max_height} options={SCREEN_HEIGHTS} name={heightName} extras={[{ value: 0, label: "No limit" }]} onChange={(value) => change({ max_height: value ?? 0 })} />
      <NumberSelect label="Highest frame rate" value={rules.max_fps} options={SCREEN_RATES} name={rateName} extras={[{ value: 0, label: "No limit" }]} onChange={(value) => change({ max_fps: value ?? 0 })} />
      <NumberSelect label="Most a share may send" value={rules.max_kbps} options={SCREEN_BITRATES} name={bitrateName} extras={[{ value: 0, label: "No limit" }]} hint="This is what each person watching costs your media server in bandwidth." onChange={(value) => change({ max_kbps: value ?? 0 })} />
      <NumberSelect label="Most a share's sound may send" value={rules.max_sound_kbps} options={SCREEN_SOUND_BITRATES} name={bitrateName} extras={[{ value: 0, label: "No limit" }]} onChange={(value) => change({ max_sound_kbps: value ?? 0 })} />
      <SettingRow title="Admins aren't held to the limits" hint="They can go past these and past how many can share at once. Sharing being off still goes for them.">
        <Switch on={rules.admins_exempt} onChange={(admins_exempt) => change({ admins_exempt })} label="Admins aren't held to the limits" />
      </SettingRow>
      <p className="screen-held">Zuna's apps keep to these, and a share already going keeps what it started with. The picture is encrypted, so the media server can't check it, and a modified app could send more.</p>

      <h3 className="settings-subhead">Suggested</h3>
      <p className="screen-held">What a share uses until someone chooses for themselves.</p>
      <NumberSelect label="Size" value={rules.default_height} options={SCREEN_HEIGHTS} name={heightName} extras={[{ value: 0, label: heightName(0) }]} limit={rules.max_height} onChange={(value) => change({ default_height: value ?? 0 })} />
      <NumberSelect label="Frame rate" value={rules.default_fps} options={SCREEN_RATES} name={rateName} limit={rules.max_fps} onChange={(value) => change({ default_fps: value ?? DEFAULT_SCREEN_RULES.default_fps })} />
      <NumberSelect label="Most it may send" value={rules.default_kbps} options={SCREEN_BITRATES} name={bitrateName} limit={rules.max_kbps} onChange={(value) => change({ default_kbps: value ?? DEFAULT_SCREEN_RULES.default_kbps })} />
      <div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await session().updateServerSettings({ screen_share: fitted() });
              toast("Saved");
            })
          }
        >
          {busy ? <Spinner /> : "Save changes"}
        </button>
      </div>
    </>
  );
}
