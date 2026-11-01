// The password meter for the iOS app: the desktop's and the web's estimator
// (@zuna/core/password), run in a JavaScriptCore context of its own, which the
// host loads only when a password field shows.

import { passwordStrength } from "@zuna/core/password";

const g = globalThis as any;

/** The strength of a password as JSON, `{ score, label }`. */
g.__zunaPasswordStrength = (password: string, related: string[]): string => JSON.stringify(passwordStrength(password, related));
