import { describe, expect, it } from "vitest";
import { passwordStrength } from "../src/password";

describe("the password meter", () => {
  it("refuses passwords from the top of cracking lists", () => {
    const common = [
      "iloveyou1", "sunshine1", "monkey123", "football1", "dragon2024", "Password1!", "Welcome1!", "Qwerty123!",
      "Liverpool1", "Polska123", "Haslo123!", "Zaq12wsx", "Summer2024!", "Kochamcie1", "password12345",
      "hunter2hunter2", "abcdefghij1234", "ZunaZunaZuna1", "N3wYork!2021", "wiosna2024",
    ];
    for (const password of common) expect(passwordStrength(password).score, password).toBeLessThan(2);
  });

  it("refuses the username and display name, however they're dressed up", () => {
    expect(passwordStrength("DanaScully1!", ["dana_scully", "Dana Scully"]).score).toBeLessThan(2);
    expect(passwordStrength("dana_scully2026", ["dana_scully"]).score).toBeLessThan(2);
  });

  it("accepts passphrases and random strings", () => {
    for (const password of ["correct horse battery", "purple monkey dishwasher", "fioletowy słoń tańczy", "x9$Lq!2vR#pW", "Gdansk#Lato77", "k7Rm2pQx9z"]) {
      expect(passwordStrength(password).score, password).toBeGreaterThanOrEqual(2);
    }
  });

  it("rates nothing typed as nothing", () => {
    expect(passwordStrength("")).toEqual({ score: 0, label: "" });
  });
});
