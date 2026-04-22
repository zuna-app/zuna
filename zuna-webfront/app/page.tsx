import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import HowItWorks from "@/components/HowItWorks";
import Downloads from "@/components/Downloads";
import SelfHost from "@/components/SelfHost";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Downloads />
        <SelfHost />
      </main>
      <Footer />
    </>
  );
}
