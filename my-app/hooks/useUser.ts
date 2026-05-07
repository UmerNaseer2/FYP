// hooks/useUser.ts
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Cache outside the hook (shared across all components)
let cachedRole: string | null = null;
let cachedUserId: string | null = null;
let fetchPromise: Promise<void> | null = null;

export function useUser() {
  const supabase = createClient();
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<string | null>(cachedRole);
  const [loading, setLoading] = useState(!cachedRole);

  useEffect(() => {
    const getUser = async () => {
      // If already cached, skip fetch
      if (cachedRole) {
        setRole(cachedRole);
        setLoading(false);
        return;
      }

      // Prevent multiple simultaneous fetches
      if (fetchPromise) {
        await fetchPromise;
        setRole(cachedRole);
        setLoading(false);
        return;
      }

      fetchPromise = (async () => {
        const { data: { user } } = await supabase.auth.getUser();
        setUser(user);
        if (user) {
          // Only query if user ID changed
          if (cachedUserId !== user.id || !cachedRole) {
            const { data } = await supabase
              .from('profiles')
              .select('role')
              .eq('id', user.id)
              .single();
            cachedRole = data?.role || 'viewer';
            cachedUserId = user.id;
          }
          setRole(cachedRole);
        } else {
          cachedRole = null;
          setRole(null);
        }
        setLoading(false);
      })();

      await fetchPromise;
      fetchPromise = null;
    };

    getUser();
  }, [supabase]);

  return { user, role, isAdmin: role === 'admin', loading };
}