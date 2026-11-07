import { CipherDemo } from "../sections/CipherDemo";
import { Compare } from "../sections/Compare";
import { Faq, FinalCall } from "../sections/Faq";
import { Features } from "../sections/Features";
import { Hero } from "../sections/Hero";
import { Platforms } from "../sections/Platforms";
import { Security } from "../sections/Security";
import { SelfHost } from "../sections/SelfHost";
import { Streaming } from "../sections/Streaming";

export function Home() {
  return (
    <>
      <Hero />
      <Features />
      <CipherDemo />
      <Streaming />
      <Security />
      <SelfHost />
      <Compare />
      <Platforms />
      <Faq />
      <FinalCall />
    </>
  );
}
