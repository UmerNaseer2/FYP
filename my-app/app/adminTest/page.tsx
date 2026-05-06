"use client";

import { useUser } from "@/hooks/useUser";

export default function AdminTestPage() {
  const { user, role, isAdmin, loading } = useUser();

  if (loading) {
    return <div className="p-8">Loading user data...</div>;
  }

  return (
    <div className="p-8 font-mono">
      <h1 className="text-2xl font-bold mb-4">Admin Test Page</h1>
      <div className="space-y-2">
        <p><strong>Logged in as:</strong> {user?.email || "Not logged in"}</p>
        <p><strong>Role from database:</strong> {role || "No role found"}</p>
        <p><strong>Is Admin?</strong> {isAdmin ? "✅ YES" : "❌ NO"}</p>
        <hr className="my-4" />
        <p className="text-sm text-gray-500">
          If role is 'admin' but isAdmin shows false, check your `useUser` hook.
        </p>
      </div>
    </div>
  );
}