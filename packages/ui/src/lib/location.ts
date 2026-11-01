// Sharing where you are, as in Telegram: this device's position, sent inside the
// message. Nothing here loads a map, which would tell a map's server where you
// are looking: opening one is a link to OpenStreetMap, in the browser.

import type { SharedLocation } from "@zuna/core";

/** "52.22970° N, 21.01220° E". */
export function coordinatesText({ lat, lon }: SharedLocation): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

/** "Within 20 m", or "Within 1.5 km". */
export function accuracyText(meters: number): string {
  if (meters < 1000) return `Within ${Math.max(1, Math.round(meters))} m`;
  return `Within ${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
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
      reject(new Error("This device can't tell where it is."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, accuracy: Math.round(coords.accuracy) }),
      (error) =>
        reject(
          new Error(
            error.code === error.PERMISSION_DENIED
              ? "Zuna isn't allowed to use your location. Allow it in your system's privacy settings."
              : error.code === error.TIMEOUT
                ? "Finding your location took too long. Try again."
                : "Your location isn't available right now.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  });
}
