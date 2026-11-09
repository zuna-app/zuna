// How presence is shown beyond what the server says.

/**
 * How long someone shows as online, to whoever saw it, after they sent a message,
 * typed, or read yours in a direct message, as Telegram's desktop app shows them
 * (`kSetOnlineAfterActivity` and `UserData::madeAction` in its data_user.cpp).
 * Tests shorten it.
 */
export const presenceTiming = { actedOnlineMs: 30_000 };
