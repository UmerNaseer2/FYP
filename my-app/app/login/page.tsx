"use client";

import { createClient } from "@/lib/supabase/client";
import { useState } from "react";

export default function LoginPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "email openid profile User.Read",
        redirectTo: `${window.location.origin}`,
      },
    });
    if (error) {
      console.error(error);
      setError(error.message);
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h2 className="login-title">Database Schema Tool</h2>
        <p className="login-subtitle">Sign in with your Microsoft account</p>
        {error && <div className="login-error">{error}</div>}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="login-button"
        >
          {loading ? "Redirecting..." : "Sign in with Microsoft"}
        </button>
        <p className="login-note">Using Supabase + Azure AD</p>
      </div>
    </div>
  );
}