// How hard a new password is to guess, with the estimator every app shares
// (@zuna/core/password). It and its word lists are large, so they load when a
// password field first shows.

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { PasswordStrength } from "@zuna/core/password";

type Estimate = typeof import("@zuna/core/password").passwordStrength;

let loading: Promise<Estimate> | null = null;
const load = (): Promise<Estimate> => (loading ??= import("@zuna/core/password").then((module) => module.passwordStrength));

/**
 * Rates `password`, using `related` (the username, the display name) as what anyone
 * guessing would try first. `current` is false while the rating is still for what
 * was typed a moment ago, or the estimator is loading, so nothing goes ahead on it.
 */
export function usePasswordStrength(password: string, related: string[] = []): PasswordStrength & { current: boolean } {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((loaded) => live && setEstimate(() => loaded));
    return () => {
      live = false;
    };
  }, []);
  // Rating can take tens of milliseconds, which mustn't hold up typing.
  const deferred = useDeferredValue(password);
  const relatedKey = related.join("\u0000");
  const strength = useMemo(
    () => (estimate ? estimate(deferred, relatedKey ? relatedKey.split("\u0000") : []) : { score: 0, label: "" }),
    [estimate, deferred, relatedKey],
  );
  return { ...strength, current: estimate !== null && deferred === password };
}
