// Fonts and styles are bundled by Vite into dist/assets; nothing loads from another host.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/noto-sans-gurmukhi/500.css";
import "./styles.css";
import { startApp } from "./app";

void startApp({ root: document.getElementById("app")! });
