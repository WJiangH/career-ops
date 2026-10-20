import { Skeleton } from "@/components/ui/skeleton";

// Same centered column as the page, so the swap does not jump.
export default function Loading() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-6" aria-label="Loading">
      <Skeleton className="size-8 rounded-full" />
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}
