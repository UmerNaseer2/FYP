import { useSession } from "next-auth/react";

export function useUser() {
  const { data: session, status } = useSession();
  const loading = status === "loading";
  const user = session?.user || null;
  const role = session?.user?.role || 'viewer';
  const isAdmin = role === 'admin';

  return { user, role, isAdmin, loading };
}