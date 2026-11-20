/**
 * Client application entry point.
 * Mounts the top-level App component (inside an error boundary, so a render error shows a recovery screen
 * instead of a blank page) inside React.StrictMode so potential lifecycle or
 * effect issues are surfaced during development, and imports global Tailwind CSS styles.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Locate the DOM root element created in apps/client/index.html and render the React tree.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
