"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <div className="login-container">
      <div className="login-card">
        <h2 className="login-title">Database Schema Tool</h2>
        <p className="login-subtitle">Sign in with your Microsoft account</p>
        <button
          onClick={() => signIn("microsoft-entra-id", { callbackUrl: "/" })}
          className="login-button"
        >
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}