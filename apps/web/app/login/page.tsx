"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const body = await response.json();
    setMessage(body.message ?? body.error ?? "Check your email.");
  }
  return <main style={{ maxWidth: 480, margin: "80px auto", padding: 24, fontFamily: "system-ui" }}>
    <h1>Sign in</h1>
    <p>Use a magic link to access your workspace datasets and analyses.</p>
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}><input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" style={{ padding: 12 }} /><button type="submit">Send magic link</button></form>
    {message && <p role="status">{message}</p>}
  </main>;
}
