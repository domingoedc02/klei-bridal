"use client";

import { FormEvent, useEffect, useState } from "react";

export default function AdminResetPasswordPage() {
  const [token, setToken] = useState("");
  const [csrfReady, setCsrfReady] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    void fetch("/api/auth/password-reset/confirm", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not prepare password reset.");
        setCsrfReady(true);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not prepare password reset."),
      );
  }, []);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("kbs_csrf="))
        ?.slice("kbs_csrf=".length);
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}),
        },
        body: JSON.stringify({ token, new_password: password }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const record = body as { error?: { message?: string } } | null;
        throw new Error(record?.error?.message ?? "Could not reset password.");
      }
      setMessage("Password reset. You can now sign in.");
      setPassword("");
      setConfirmation("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <h1>Set new password</h1>
      <p>Choose a new password for your staff account.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          name="new_password"
          type="password"
          minLength={12}
          maxLength={1024}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <label htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          minLength={12}
          maxLength={1024}
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
        <button type="submit" disabled={pending || !token || !csrfReady}>
          {pending ? "Saving…" : "Set password"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
        {message ? <p role="status">{message}</p> : null}
      </form>
    </main>
  );
}
