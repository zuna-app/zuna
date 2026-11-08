// How hard a new password is to guess, with the estimator every app shares
// (@zuna/core/password). It and its word lists are large, so they load when a
// password field first shows.

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { PasswordStrength } from "@zuna/core/password";

type Estimate = typeof import("@zuna/core/password").passwordStrength;

let loading: Promise<Estimate> | null = null;
// One that failed, as when an update to zuna-web took away the old files, is tried again next time.
const load = (): Promise<Estimate> =>
  (loading ??= import("@zuna/core/password")
    .then((module) => module.passwordStrength)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    }));

const FAILED: PasswordStrength = { score: 0, label: "Couldn't load the password checker. Reload the page." };

/**
 * Rates `password`, using `related` (the username, the display name) as what anyone
 * guessing would try first. `score` and `label` can trail what was typed by a moment,
 * and a form's button goes by them, so it doesn't flicker off with each key. Before
 * anything goes ahead, `accepts()` rates exactly what's typed, and says whether
 * it's strong enough.
 */
export function usePasswordStrength(password: string, related: string[] = []): PasswordStrength & { accepts: () => boolean } {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(
      (loaded) => live && setEstimate(() => loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  // Rating can take tens of milliseconds, which mustn't hold up typing.
  const deferred = useDeferredValue(password);
  const relatedKey = related.join("\u0000");
  const strength = useMemo(
    () => (estimate ? estimate(deferred, relatedKey ? relatedKey.split("\u0000") : []) : failed ? FAILED : { score: 0, label: "" }),
    [estimate, failed, deferred, relatedKey],
  );
  const accepts = () => estimate !== null && (deferred === password ? strength : estimate(password, related)).score >= 2;
  return { ...strength, accepts };
}
