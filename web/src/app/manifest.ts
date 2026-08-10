import type { MetadataRoute } from "next";

// Web app manifest — what turns the tab into an installed app.
//
// Added to the home screen this launches standalone: its own icon, its own
// entry in the app switcher, no address bar and no tab strip. Which is the
// whole point of the "should it be an app?" question — on iOS a PWA answers it
// without an App Store review of a tool that automates job applications.
//
// display "standalone" rather than "fullscreen": the status bar (clock,
// battery, signal) stays, which is what every native app does. Paired with the
// existing appleWebApp.statusBarStyle "black-translucent" and viewportFit
// "cover", so the header sits flush under the Dynamic Island.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "career-ops",
    short_name: "career-ops",
    description: "Local-first job search — evaluations, pipeline and applications, driven from your own machine.",
    start_url: "/pipeline",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches the light --bg. The real theme-color is corrected before paint by
    // THEME_SCRIPT in layout.tsx; this is only the pre-launch splash tint.
    background_color: "#f7f6f3",
    theme_color: "#f7f6f3",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // maskable so Android can crop to its adaptive shape without clipping the
      // mark; the brand square already carries its own padding.
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Long-press the home-screen icon → jump straight to the two things you
    // open the phone for: what is running, and what to look at next.
    shortcuts: [
      { name: "Pipeline", short_name: "Pipeline", url: "/pipeline" },
      { name: "Explore", short_name: "Explore", url: "/explore" },
    ],
  };
}
