import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../../../packages/ui/src/styles/tokens.css";
import "./styles/base.css";
import "./styles/sections.css";
import "./styles/window.css";
import "./styles/prose.css";

import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { pageFor, type PageId } from "./pages";

// Sections only wait to fade in once something can bring them in.
document.documentElement.classList.add("js");

const root = document.getElementById("root")!;
// A prerendered page says which it is, since 404.html is served at any address.
const page = (root.dataset.page as PageId | undefined) ?? pageFor(location.pathname);
const app = (
  <StrictMode>
    <App page={page} />
  </StrictMode>
);

if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
