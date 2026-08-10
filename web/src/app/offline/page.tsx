import { CloudOff } from "lucide-react";

export const metadata = { title: "Offline — career-ops" };

// Shown by the service worker when a navigation fails and no cached copy of
// that page exists. Deliberately specific: this app runs on your own Mac, so
// "offline" almost never means the phone has no signal — it means the laptop
// is asleep, or you left its network. Naming the actual fix beats a generic
// "check your connection" that sends you to the wrong place.
export default function Offline() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <CloudOff className="size-8 text-faint" />
      <h1 className="text-xl font-semibold">Your Mac isn&apos;t answering</h1>
      <p className="text-sm leading-relaxed text-muted">
        career-ops runs on your own machine, so this page needs it awake and reachable. It is usually one of:
      </p>
      <ul className="space-y-1.5 text-left text-sm text-muted">
        <li>— the Mac is asleep. On battery it sleeps after a minute; plugged in it stays up.</li>
        <li>— Tailscale is off on this phone, so the tailnet address will not resolve.</li>
        <li>— the hub is not running. On the Mac: <code className="rounded bg-surface px-1 py-0.5 text-xs">hub-status</code></li>
      </ul>
      <p className="pt-2 text-sm text-muted">
        Nothing is lost — evaluations already running keep going on the Mac, and their transcripts are on disk. Reopen this once it is back.
      </p>
    </div>
  );
}
