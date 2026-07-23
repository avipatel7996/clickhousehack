"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, mode }) });
    const body = await response.json();
    setMessage(body.message ?? body.error ?? "Check your email.");
  }
  return <main style={{ maxWidth: 480, margin: "80px auto", padding: 24, fontFamily: "system-ui" }}>
    <h1>Sign in</h1>
    <p>Sign in to access your workspace datasets and analyses.</p>
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}><input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" style={{ padding: 12 }} /><input type="password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} placeholder="Password (8+ characters)" style={{ padding: 12 }} /><button type="submit">{mode === "sign-up" ? "Create account" : "Sign in"}</button></form>
    <button type="button" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")} style={{ marginTop: 12 }}>{mode === "sign-in" ? "Create a new account" : "Already have an account? Sign in"}</button>
    <p style={{ color: "#64748b" }}>Magic-link login remains available through the API if needed.</p>
    {message && <p role="status">{message}</p>}
  </main>;
}
