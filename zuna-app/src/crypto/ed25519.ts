import crypto from "crypto";

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  const publicSpki = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });

  // SPKI DER for ed25519 is always 44 bytes: 12-byte ASN.1 header + 32-byte raw key.
  // Go's ed25519.Verify requires the raw 32-byte key.
  const publicRaw = publicSpki.subarray(12);

  return {
    publicKey: publicRaw.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}

export function signMessage(privateKey: string, nonce: string): string {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(
    null,
    Buffer.from(nonce, "utf8"),
    privateKeyObj,
  );

  return signature.toString("base64");
}
