import { CipherDemo } from "../sections/CipherDemo";
import { Devices } from "../sections/Devices";
import { Faq, FinalCall } from "../sections/Faq";
import { Features } from "../sections/Features";
import { Hero } from "../sections/Hero";
import { Platforms } from "../sections/Platforms";
import { Push } from "../sections/Push";
import { Security } from "../sections/Security";
import { SelfHost } from "../sections/SelfHost";
import { Streaming } from "../sections/Streaming";

export function Home() {
  return (
    <>
      <Hero />
      <CipherDemo />
      <Features />
      <Devices />
      <Streaming />
      <Security />
      <Push />
      <SelfHost />
      <Platforms />
      <Faq />
      <FinalCall />
    </>
  );
}
