import { useEffect, useRef, useState } from "react";
import { prefersLessMotion } from "./reveal";

const NOISE = "0123456789abcdef";

/** Text that comes out of noise, a letter at a time, the first time it's seen. */
export function DecryptText({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || prefersLessMotion()) return;
    let frame = 0;
    let started = 0;
    const duration = 900;
    const step = (now: number) => {
      started ||= now;
      const done = Math.min(1, (now - started) / duration);
      const settled = Math.floor(done * text.length);
      setShown(
        text
          .split("")
          .map((letter, index) => (index < settled || letter === " " ? letter : NOISE[Math.floor(Math.random() * NOISE.length)]))
          .join(""),
      );
      if (done < 1) frame = requestAnimationFrame(step);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry!.isIntersecting) return;
      observer.disconnect();
      frame = requestAnimationFrame(step);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [text]);

  return (
    <span ref={ref}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}
