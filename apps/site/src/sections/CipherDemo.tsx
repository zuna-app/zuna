import { useEffect, useRef, useState } from "react";
import { DecryptText } from "../components/DecryptText";

const FIRST = "See you at 9 by the lake";
// What the prerendered page shows until the browser has made a key and encrypted the first message.
const PLACEHOLDER = "84ee1632e75cb7ae9689c45aaa81d7890dd2985e0843ac3550d6ec76d4e4ea533088ed8893043bf5879f67b6c490eb4b9429095cec857a01a74612f350c94ab7017e27a7a143803174c21749f2c3bc3413095a35c1450f1dd25e9c4d18f83130";

/**
 * A real encryption, with a key made in this page, to show what the server gets: who sent it, where and
 * when, and a block of noise padded to 256 bytes as Zuna pads messages. Zuna's own keys come from MLS.
 */
export function CipherDemo() {
  const [text, setText] = useState(FIRST);
  const [cipher, setCipher] = useState({ hex: PLACEHOLDER, size: 256 });
  const key = useRef<Promise<CryptoKey> | null>(null);

  useEffect(() => {
    if (!crypto.subtle) return;
    key.current ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    let current = true;
    void encrypt(key.current, text).then((result) => current && setCipher(result));
    return () => {
      current = false;
    };
  }, [text]);

  return (
    <section className="section" id="demo">
      <div className="wrap">
        <div className="section-head center reveal">
          <p className="eyebrow">What the server sees</p>
          <h2 className="heading">
            <DecryptText text="Your server only ever sees noise." />
          </h2>
          <p className="lead">Type something. On the right is everything the server gets.</p>
        </div>
        <div className="demo reveal">
          <div className="demo-side">
            <p className="demo-label">What Sam sees</p>
            <div className="demo-chat">
              <div className="demo-bubble">{text || " "}</div>
            </div>
            <label className="demo-input">
              <span className="sr-only">Your message</span>
              <input value={text} maxLength={400} onChange={(event) => setText(event.target.value)} placeholder="Write a message" />
            </label>
          </div>
          <div className="demo-side demo-server">
            <p className="demo-label">What the server stores</p>
            <dl className="demo-meta">
              <div>
                <dt>From</dt>
                <dd>alex</dd>
              </div>
              <div>
                <dt>To</dt>
                <dd>group 7f2e…</dd>
              </div>
              <div>
                <dt>At</dt>
                <dd>19:21:04</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{cipher.size} bytes</dd>
              </div>
            </dl>
            <p className="demo-cipher">{cipher.hex}…</p>
          </div>
        </div>
        <p className="note center reveal">
          The server knows who wrote to which chat, when, and roughly how much. Never what. Messages are padded to blocks of 256 bytes, so length gives little away.
        </p>
      </div>
    </section>
  );
}

async function encrypt(key: Promise<CryptoKey>, text: string): Promise<{ hex: string; size: number }> {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / 256) * 256);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, padded));
  const hex = Array.from(sealed.subarray(0, 96), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { hex, size: padded.length };
}
