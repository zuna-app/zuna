import type { SharedLocation } from "@zuna/core";
import { MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal, Spinner, useAction } from "@/components/ui";
import { t } from "@/lib/i18n";
import { accuracyText, coordinatesText, locate } from "@/lib/location";
import { useApp } from "@/state/store";

/** Finds where this device is and, once that's shown, sends it to a chat. */
export function ShareLocation({ conversationKey, onClose }: { conversationKey: string; onClose: () => void }) {
  const session = useApp((state) => state.session);
  const { busy, run } = useAction();
  const [found, setFound] = useState<SharedLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFound(null);
    setError(null);
    locate().then(
      (location) => !cancelled && setFound(location),
      (failure: Error) => !cancelled && setError(failure.message),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const send = () =>
    run(async () => {
      await session().sendMessage(conversationKey, { location: found! });
      onClose();
    });

  return (
    <Modal
      title={t("location.share.title")}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          {error ? (
            <button className="btn btn-primary" onClick={() => setAttempt((count) => count + 1)}>{t("common.tryAgain")}</button>
          ) : (
            <button className="btn btn-primary" disabled={!found || busy} onClick={() => void send()}>
              {busy ? <Spinner /> : t("location.share.send")}
            </button>
          )}
        </>
      }
    >
      <div className="share-location">
        <span className="location-pin is-large">
          <MapPin size={26} />
        </span>
        {found ? (
          <span className="location-text">
            <b>{t("location.share.current")}</b>
            <span className="selectable">{coordinatesText(found)}</span>
            {found.accuracy !== undefined && <span className="faint">{accuracyText(found.accuracy)}</span>}
          </span>
        ) : error ? (
          <span className="location-text">{error}</span>
        ) : (
          <span className="location-text">
            <span className="row" style={{ gap: 8 }}>
              <Spinner size={14} /> {t("location.share.finding")}
            </span>
          </span>
        )}
      </div>
      <p className="faint" style={{ fontSize: 12.5 }}>{t("location.share.note")}</p>
    </Modal>
  );
}
