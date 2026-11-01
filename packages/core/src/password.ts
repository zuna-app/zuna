// How hard a new password is to guess, for sign-up and changing it. Every app uses
// this one estimator: the desktop and the web load it when a password field shows,
// and iOS runs it in a JavaScriptCore context of its own (apps/ios/core-bundle).
//
// A password protects everything the account can read, against anyone with the
// server's data, who can test guesses offline. So this goes by how many guesses an
// attacker who knows common passwords, words, names, dates and keyboard patterns
// would need (zxcvbn), and not by length and character classes, which rate
// "Password1!" as well as a random string.

import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as en from "@zxcvbn-ts/language-en";
import * as pl from "@zxcvbn-ts/language-pl";

export interface PasswordStrength {
  /** 0 for nothing typed, then 1 to 4. Sign-up and changing a password ask for 2 or more. */
  score: number;
  label: string;
}

let estimator: ZxcvbnFactory | null = null;

/**
 * Rates a password from 0 to 4. `related` is what anyone guessing would try
 * first, such as the username and display name.
 */
export function passwordStrength(password: string, related: string[] = []): PasswordStrength {
  if (!password) return { score: 0, label: "" };
  estimator ??= new ZxcvbnFactory({
    translations: en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary, ...pl.dictionary },
  });
  // "Dana Scully" is guessed as "danascully" and "scully" as well.
  const inputs = ["zuna", ...related].flatMap((input) => [input, input.replace(/[^\p{L}\p{N}]+/gu, ""), ...input.split(/[^\p{L}\p{N}]+/u)]).filter((input) => input.length > 1);
  const { guessesLog10 } = estimator.check(password, inputs);
  // A billion guesses of Argon2id at 64 MiB take one graphics card days to weeks.
  if (guessesLog10 < 9) return { score: 1, label: "Too easy to guess" };
  if (guessesLog10 < 11) return { score: 2, label: "Could be stronger" };
  if (guessesLog10 < 14) return { score: 3, label: "Good" };
  return { score: 4, label: "Strong" };
}
