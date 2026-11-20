/**
 * Client application entry point.
 * Mounts the top-level App component inside React.StrictMode so potential lifecycle or
 * effect issues are surfaced during development, and imports global Tailwind CSS styles.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Locate the DOM root element created in apps/client/index.html and render the React tree.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
