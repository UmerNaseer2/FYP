// src/app/login/page.tsx
"use client";

import { useState } from "react";

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);

  const handleMockLogin = () => {
    setIsLoading(true);
    // Simulate a network request
    setTimeout(() => {
      setIsLoading(false);
      // Set a mock auth cookie (so middleware knows user is logged in)
      document.cookie = "mock-auth=true; path=/";
      // Redirect to connections page
      window.location.href = "/connections";
    }, 1000);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-8 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">
            Database Schema Tool
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Sign in with your Microsoft account
          </p>
        </div>

        <button
          onClick={handleMockLogin}
          disabled={isLoading}
          className="group relative flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-70"
        >
          {isLoading ? (
            "Signing in..."
          ) : (
            <>
              <span className="absolute inset-y-0 left-0 flex items-center pl-3">
                {/* Microsoft logo SVG */}
                <svg className="h-5 w-5 text-white" viewBox="0 0 23 23" fill="currentColor">
                  <path d="M11.5 0H23v11.5H11.5zM0 11.5h11.5V23H0zM11.5 11.5H23V23H11.5zM0 0h11.5v11.5H0z" />
                </svg>
              </span>
              Sign in with Microsoft
            </>
          )}
        </button>

        <p className="text-center text-xs text-gray-500">
          Front‑end prototype — authentication mock only.
        </p>
      </div>
    </div>
  );
}