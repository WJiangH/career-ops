"use client";

import { useEffect } from "react";

// Registers the offline shell worker.
//
// Guarded on isSecureContext because the LAN address is plain http, where
// registration is refused — no point throwing on every load there. Over the
// Tailscale HTTPS name it registers and the app opens even with the Mac
// asleep. `updateViaCache: "none"` so a rebuilt sw.js is picked up rather than
// served from the HTTP cache for its lifetime.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    const t = setTimeout(() => {
      // Deferred past first paint: registration competes with the initial data
      // fetches otherwise, and nothing about it is needed on the first load.
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        /* unsupported or blocked — the app works without it */
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  return null;
}
