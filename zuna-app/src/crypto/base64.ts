export function toBase64(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64");
}

export function fromBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf-8");
}
