// What scripts/ios-dist.mjs decides before it lets a build go to TestFlight: which profiles may
// sign it and whether its entitlements came through the export. Run with `npm run test:release`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { entitlementProblems, filled, plist, PROFILES, profileProblem, SECRETS } from "./ios-dist.mjs";

const profile = (changes = {}) => ({
  uuid: "6a1f3c2e-0000-4000-8000-000000000000",
  name: "Zuna App Store",
  team: "SGKB9R23YT",
  bundle: "chat.zuna.mobile",
  debuggable: false,
  devices: false,
  expires: new Date("2027-11-11T00:00:00Z"),
  certificates: ["A".repeat(40)],
  ...changes,
});
const wants = { bundle: "chat.zuna.mobile", team: "SGKB9R23YT", certificate: "A".repeat(40), now: new Date("2026-11-11T00:00:00Z") };

test("only an App Store profile of the bundle, the team and the certificate signs it", () => {
  assert.equal(profileProblem(profile(), wants), null);
  assert.match(profileProblem(profile({ bundle: "chat.zuna.mobile.share" }), wants), /not of chat\.zuna\.mobile/);
  assert.match(profileProblem(profile({ team: "XXXXXXXXXX" }), wants), /team XXXXXXXXXX's/);
  assert.match(profileProblem(profile({ devices: true }), wants), /development or ad hoc/);
  assert.match(profileProblem(profile({ debuggable: true }), wants), /development or ad hoc/);
  assert.match(profileProblem(profile({ expires: new Date("2026-11-10T00:00:00Z") }), wants), /expired on 2026-11-10/);
  assert.match(profileProblem(profile({ certificates: ["B".repeat(40)] }), wants), /wasn't made with the distribution certificate/);
  // Without a certificate to hold it to, as when only the profile is known.
  assert.equal(profileProblem(profile({ certificates: [] }), { ...wants, certificate: undefined }), null);
});

test("every bundle has a profile, and every secret upload needs is named", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["chat.zuna.mobile", "chat.zuna.mobile.broadcast", "chat.zuna.mobile.notifications", "chat.zuna.mobile.share"]);
  assert.equal(new Set(SECRETS).size, SECRETS.length);
  for (const secret of Object.values(PROFILES)) assert.ok(SECRETS.includes(secret));
});

test("the entitlements files get the team's prefix where Xcode puts it", () => {
  const file = { "keychain-access-groups": ["$(AppIdentifierPrefix)chat.zuna.shared"], "aps-environment": "development", "com.apple.developer.usernotifications.communication": true };
  assert.deepEqual(filled(file, "SGKB9R23YT."), { "keychain-access-groups": ["SGKB9R23YT.chat.zuna.shared"], "aps-environment": "development", "com.apple.developer.usernotifications.communication": true });
});

test("a TestFlight build has what its entitlements file asks for, with production push", () => {
  const wanted = { "aps-environment": "development", "com.apple.security.application-groups": ["group.chat.zuna.mobile"], "keychain-access-groups": ["SGKB9R23YT.chat.zuna.shared"] };
  const signed = { ...wanted, "aps-environment": "production", "application-identifier": "SGKB9R23YT.chat.zuna.mobile", "get-task-allow": false, "beta-reports-active": true };
  assert.deepEqual(entitlementProblems("Zuna.app", wanted, signed), []);
  // What an export of an archive with no signature at all gives: nothing it asked for.
  const bare = { "application-identifier": "SGKB9R23YT.chat.zuna.mobile", "get-task-allow": false, "beta-reports-active": true };
  assert.equal(entitlementProblems("Zuna.app", wanted, bare).length, 3);
  assert.match(entitlementProblems("Zuna.app", wanted, { ...signed, "aps-environment": "development" })[0], /aps-environment "development", not "production"/);
  assert.match(entitlementProblems("Zuna.app", wanted, { ...signed, "get-task-allow": true })[0], /can be debugged/);
  assert.match(entitlementProblems("Zuna.app", wanted, { ...signed, "beta-reports-active": undefined })[0], /isn't signed for TestFlight/);
  // A bundle with no entitlements file only needs the distribution's own.
  assert.deepEqual(entitlementProblems("Plain.appex", {}, { "get-task-allow": false, "beta-reports-active": true }), []);
});

test("the export's options are written as a property list", () => {
  const written = plist({ method: "app-store-connect", uploadSymbols: true, internal: false, provisioningProfiles: { "chat.zuna.mobile": "a&b<c>" }, list: ["x"] });
  assert.match(written, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(written, /\n<dict>\n {2}<key>method<\/key>\n {2}<string>app-store-connect<\/string>/);
  assert.match(written, /<key>uploadSymbols<\/key>\n {2}<true\/>/);
  assert.match(written, /<key>internal<\/key>\n {2}<false\/>/);
  assert.match(written, /<key>chat\.zuna\.mobile<\/key>\n {4}<string>a&amp;b&lt;c&gt;<\/string>/);
  assert.match(written, /<array>\n {4}<string>x<\/string>\n {2}<\/array>/);
  assert.match(written, /<\/dict>\n<\/plist>\n$/);
});
