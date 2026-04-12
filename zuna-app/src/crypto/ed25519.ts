import crypto from "crypto";

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });

  return {
    publicKey: publicDer.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}

export function signMessage(privateKey: string, message: string): string {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(
    null,
    Buffer.from(message, "utf8"),
    privateKeyObj,
  );

  return signature.toString("base64");
}
