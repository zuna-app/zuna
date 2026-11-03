import { Footer } from "./components/Footer";
import { Nav } from "./components/Nav";
import { useReveal } from "./components/reveal";
import { Home } from "./pages/Home";
import { Missing } from "./pages/Missing";
import { Privacy } from "./pages/Privacy";
import { Support } from "./pages/Support";
import type { PageId } from "./pages";

export function App({ page }: { page: PageId }) {
  useReveal();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Nav home={page === "home"} />
      <main id="main">
        {page === "home" && <Home />}
        {page === "privacy" && <Privacy />}
        {page === "support" && <Support />}
        {page === "missing" && <Missing />}
      </main>
      <Footer />
    </>
  );
}
