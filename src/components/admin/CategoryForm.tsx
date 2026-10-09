"use client";

import { FormEvent, useState } from "react";

type CategoryType = "silhouettes" | "materials" | "collections";

type ApiError = {
  message: string;
  suggestion?: { name: string };
};

export function readCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("kbs_csrf="));
  return match ? decodeURIComponent(match.slice("kbs_csrf=".length)) : undefined;
}

export async function readApiError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null)
      return { message: `Request failed (${response.status})` };
    const record = body as Record<string, unknown>;
    const error = record.error;
    const errorRecord =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
    const suggestion = record.suggestion;
    const suggestionRecord =
      typeof suggestion === "object" && suggestion !== null
        ? (suggestion as Record<string, unknown>)
        : undefined;
    return {
      message:
        typeof errorRecord?.message === "string"
          ? errorRecord.message
          : typeof record.message === "string"
            ? record.message
            : `Request failed (${response.status})`,
      suggestion:
        typeof suggestionRecord?.name === "string" ? { name: suggestionRecord.name } : undefined,
    };
  } catch {
    return { message: `Request failed (${response.status})` };
  }
}

export default function CategoryForm({
  type,
  onCreated,
}: {
  type: CategoryType;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>, confirmNearDuplicate = false) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const csrf = readCsrfToken();
      const response = await fetch(`/api/admin/${type}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({
          name: name.trim(),
          ...(confirmNearDuplicate ? { confirm_near_duplicate: true } : {}),
        }),
      });
      if (!response.ok) {
        const nextError = await readApiError(response);
        setError(nextError);
        return;
      }
      setName("");
      onCreated();
    } catch {
      setError({ message: "Could not reach category service. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="category-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`${type}-new-name`}>Add {type.slice(0, -1)}</label>
      <div className="form-row">
        <input
          id={`${type}-new-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          aria-describedby={error ? `${type}-form-error` : undefined}
        />
        <button type="submit" disabled={pending || !name.trim()}>
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? (
        <p className="form-error" id={`${type}-form-error`} role="alert">
          {error.message}
          {error.suggestion ? (
            <>
              {" "}
              Existing match: <strong>{error.suggestion.name}</strong>.{" "}
              <button
                type="button"
                className="text-button"
                onClick={(event) =>
                  void submit(event as unknown as FormEvent<HTMLFormElement>, true)
                }
                disabled={pending}
              >
                Create anyway
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

export type { CategoryType };
