import type { ScreenRules } from "@zuna/core";
import { DEFAULT_SCREEN_RULES, screenTerms } from "@zuna/core/voice";
import { useEffect, useState } from "react";
import { Field, Spinner, Switch, useAction } from "@/components/ui";
import { SettingRow } from "@/features/overlays/Settings";
import { t } from "@/lib/i18n";
import { useActiveServer, useApp } from "@/state/store";
import { bitrateName, heightName, rateName, SCREEN_BITRATES, SCREEN_HEIGHTS, SCREEN_LIMIT_BITRATES, SCREEN_RATES, screenLimitsText, VOICE_DEFAULTS } from "@/voice/settings";
import { useVoice } from "@/voice/store";

/**
 * A choice among numbers, with those a server's limit rules out shown as unavailable. Extras
 * go first, such as leaving it to the app, and a value set some other way stays in the list.
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
  const automatic = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: null }, rules, role).kbps;
  const limits = screenLimitsText(rules, role);

  return (
    <>
      <h1>{t("settings.sections.screen")}</h1>
      {limits && <p className="screen-held">{limits}</p>}

      <h3 className="settings-subhead">{t("voice.screenSettings.quality")}</h3>
      <NumberSelect label={t("voice.screenSettings.resolution")} value={settings.screenHeight} options={[0, ...SCREEN_HEIGHTS]} name={heightName} limit={limit(shown.max_height)} onChange={(value) => update({ screenHeight: value ?? 0 })} />
      <NumberSelect label={t("voice.screenSettings.frameRate")} value={settings.screenFps} options={SCREEN_RATES} name={rateName} limit={limit(shown.max_fps)} onChange={(value) => update({ screenFps: value ?? VOICE_DEFAULTS.screenFps })} />
      <NumberSelect
        label={t("voice.stats.maxBitrate")}
        value={settings.screenBitrate}
        options={SCREEN_BITRATES}
        name={bitrateName}
        extras={[{ value: null, label: t("voice.screenSettings.automaticBitrate", { bitrate: bitrateName(automatic) }) }]}
        limit={limit(shown.max_kbps)}
        hint={t("voice.screenSettings.maxBitrateHint")}
        onChange={(value) => update({ screenBitrate: value })}
      />

      <h3 className="settings-subhead">{t("voice.screenSettings.audio")}</h3>
      {shown.sound ? (
        <SettingRow title={t("voice.screenSettings.includeAudio")} hint={t("voice.screenSettings.includeAudioBrowserHint")}>
          <Switch on={settings.screenSoundByDefault} onChange={(value) => update({ screenSoundByDefault: value })} label={t("voice.screenSettings.includeAudio")} />
        </SettingRow>
      ) : (
        <p className="screen-held">{t("voice.screenSettings.noAudio")}</p>
      )}

      <h3 className="settings-subhead">{t("voice.screenSettings.watching")}</h3>
      <SettingRow title={t("voice.screenSettings.autoOpen")} hint={t("voice.screenSettings.autoOpenHint")}>
        <Switch on={settings.screenFocus} onChange={(value) => update({ screenFocus: value })} label={t("voice.screenSettings.autoOpen")} />
      </SettingRow>
      <label className="field">
        <span className="field-label">
          {t("voice.screenSettings.volume")} <b style={{ fontWeight: 500 }}>{Math.round(settings.screenVolume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={2} step={0.01} value={settings.screenVolume} onChange={(event) => update({ screenVolume: Number(event.target.value) })} />
      </label>
    </>
  );
}

/** What this server allows for sharing a screen, for its admins. */
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

  return (
    <>
      <h1>{t("serverSettings.sections.screen")}</h1>
      <p className="settings-lead">{t("voice.serverScreen.lead")}</p>
      {!server?.info?.voice && <p className="channel-voice-note">{t("channels.noMediaServer")}</p>}

      <h3 className="settings-subhead">{t("voice.serverScreen.permissions")}</h3>
      <SettingRow title={t("voice.serverScreen.whoCanShare")} hint={t("voice.serverScreen.whoCanShareHint")}>
        <Segmented
          value={rules.who}
          options={[
            { id: "everyone", label: t("voice.serverScreen.everyone") },
            { id: "admins", label: t("voice.serverScreen.admins") },
            { id: "nobody", label: t("voice.serverScreen.nobody") },
          ]}
          onChange={(who) => change({ who })}
          label={t("voice.serverScreen.whoCanShare")}
        />
      </SettingRow>
      <SettingRow title={t("voice.serverScreen.allowAudio")} hint={t("voice.serverScreen.allowAudioHint")}>
        <Switch on={rules.sound} onChange={(sound) => change({ sound })} label={t("voice.serverScreen.allowAudio")} />
      </SettingRow>
      <Field label={t("voice.serverScreen.maxPerChannel")} type="number" min={0} max={99} value={String(rules.max_per_channel)} hint={t("voice.serverScreen.maxPerChannelHint")} onChange={(event) => change({ max_per_channel: count(event.target.value) })} />
      <Field label={t("voice.serverScreen.maxPerServer")} type="number" min={0} max={1000} value={String(rules.max_per_server)} hint={t("voice.serverScreen.maxPerServerHint")} onChange={(event) => change({ max_per_server: count(event.target.value) })} />

      <h3 className="settings-subhead">{t("voice.serverScreen.qualityLimits")}</h3>
      <NumberSelect label={t("voice.serverScreen.maxResolution")} value={rules.max_height} options={SCREEN_HEIGHTS} name={heightName} extras={[{ value: 0, label: t("common.noLimit") }]} onChange={(value) => change({ max_height: value ?? 0 })} />
      <NumberSelect label={t("voice.serverScreen.maxFrameRate")} value={rules.max_fps} options={SCREEN_RATES} name={rateName} extras={[{ value: 0, label: t("common.noLimit") }]} onChange={(value) => change({ max_fps: value ?? 0 })} />
      <NumberSelect label={t("voice.stats.maxBitrate")} value={rules.max_kbps} options={SCREEN_LIMIT_BITRATES} name={bitrateName} extras={[{ value: 0, label: t("common.noLimit") }]} hint={t("voice.serverScreen.maxBitrateHint")} onChange={(value) => change({ max_kbps: value ?? 0 })} />
      <SettingRow title={t("voice.serverScreen.adminsExempt")} hint={t("voice.serverScreen.adminsExemptHint")}>
        <Switch on={rules.admins_exempt} onChange={(admins_exempt) => change({ admins_exempt })} label={t("voice.serverScreen.adminsExempt")} />
      </SettingRow>
      <p className="screen-held">{t("voice.serverScreen.note")}</p>
      <div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await session().updateServerSettings({ screen_share: rules });
              toast(t("common.saved"));
            })
          }
        >
          {busy ? <Spinner /> : t("common.saveChanges")}
        </button>
      </div>
    </>
  );
}
