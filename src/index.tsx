import { render } from "preact";
import { ScanPage } from "./pages/Scan";
import "./style.css";

export function App() {
  return <ScanPage />;
}

const appElement = document.getElementById("app");
if (!appElement) throw new Error("App element not found");
render(<App />, appElement);
