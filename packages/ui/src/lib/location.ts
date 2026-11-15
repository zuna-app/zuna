// Sharing where you are, as in Telegram: this device's position, sent inside the
// message. Nothing here loads a map, which would tell a map's server where you
// are looking: opening one is a link to OpenStreetMap, in the browser.

import type { SharedLocation } from "@zuna/core";
import { t } from "@/lib/i18n";

/** "52.22970° N, 21.01220° E". */
export function coordinatesText({ lat, lon }: SharedLocation): string {
  const vars = { latitude: Math.abs(lat).toFixed(5), longitude: Math.abs(lon).toFixed(5) };
  if (lat >= 0) return lon >= 0 ? t("location.coordinatesNE", vars) : t("location.coordinatesNW", vars);
  return lon >= 0 ? t("location.coordinatesSE", vars) : t("location.coordinatesSW", vars);
}

/** "Within 20 m", or "Within 1.5 km". */
export function accuracyText(meters: number): string {
  if (meters < 1000) return t("location.withinMeters", { distance: Math.max(1, Math.round(meters)) });
  return t("location.withinKilometers", { distance: (meters / 1000).toFixed(meters < 10_000 ? 1 : 0) });
}

/** Where a location opens. */
export function mapLink({ lat, lon }: SharedLocation): string {
  const at = `${lat.toFixed(6)}/${lon.toFixed(6)}`;
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=16/${at}`;
}

/** This device's position, or why there isn't one, in words to show. */
export function locate(): Promise<SharedLocation> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error(t("location.unavailableHere")));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, accuracy: Math.round(coords.accuracy) }),
      (error) =>
        reject(
          new Error(
            error.code === error.PERMISSION_DENIED
              ? t("location.notAllowed")
              : error.code === error.TIMEOUT
                ? t("location.timedOut")
                : t("location.unavailable"),
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  });
}
