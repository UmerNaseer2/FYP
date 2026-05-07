"use client";

import { useUser } from "@/hooks/useUser";
import Link from "next/link";

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
        <Link href="/">
          <button className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            Go to Dashboard
          </button>
        </Link>
      </div>
    </div>
  );
}