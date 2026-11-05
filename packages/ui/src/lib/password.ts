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
 * guessing would try first. `score` and `label` can trail what was typed by a moment,
 * and a form's button goes by them, so it doesn't flicker off with each key. Before
 * anything goes ahead, `accepts()` rates exactly what's typed, and says whether
 * it's strong enough.
 */
export function usePasswordStrength(password: string, related: string[] = []): PasswordStrength & { accepts: () => boolean } {
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
  const accepts = () => estimate !== null && (deferred === password ? strength : estimate(password, related)).score >= 2;
  return { ...strength, accepts };
}
