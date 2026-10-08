"use client";

// Next.js requires error.tsx to be a Client Component (it needs the
// `reset` callback). This does not violate the "no use client at a
// public page root" rule — it is an error boundary, not a page.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>{error.digest ? `Reference: ${error.digest}` : "Please try again."}</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
