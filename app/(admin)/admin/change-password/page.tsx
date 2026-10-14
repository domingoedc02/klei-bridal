"use client";

import { FormEvent, useState } from "react";

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const csrf = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("kbs_csrf="))
      ?.slice("kbs_csrf=".length);
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}),
      },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not change password.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setMessage("Password changed. Continue to admin.");
    window.location.assign("/admin");
  }

  return (
    <main>
      <h1>Change password</h1>
      <p>Change temporary password before using admin.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          minLength={12}
          maxLength={1024}
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <button type="submit">Change password</button>
        {error ? <p role="alert">{error}</p> : null}
        {message ? <p role="status">{message}</p> : null}
      </form>
    </main>
  );
}
