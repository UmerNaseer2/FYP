import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { User } from '@supabase/supabase-js';

// Module-level cache so the first paint after a client-side navigation is
// instant instead of flashing a loading state. It is kept honest two ways:
//   1. resetUserCache() is called from the sign-out handlers, and
//   2. the onAuthStateChange listener below updates it on sign-in / sign-out /
//      token refresh — including changes made in another tab.
// So it can no longer show a signed-in identity after the session is gone.
let cachedUser: User | null = null;
let cachedRole: string | null = null;

/** Clear the cached identity. Call this from sign-out handlers. */
export function resetUserCache() {
  cachedUser = null;
  cachedRole = null;
}

export function useUser() {
  // Keep ONE stable client instance for the hook's lifetime so the effect below
  // subscribes exactly once (createClient() returns a new wrapper each call).
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(cachedUser);
  const [role, setRole] = useState<string | null>(cachedRole);
  const [loading, setLoading] = useState(!cachedUser);

  useEffect(() => {
    let active = true;

    async function resolveRole(nextUser: User | null): Promise<string | null> {
      if (!nextUser) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', nextUser.id)
        .single();
      if (error) {
        console.error('Error fetching role:', error.message);
        return 'viewer';
      }
      return data?.role || 'viewer';
    }

    async function sync(nextUser: User | null) {
      const nextRole = await resolveRole(nextUser);
      if (!active) return;
      cachedUser = nextUser;
      cachedRole = nextRole;
      setUser(nextUser);
      setRole(nextRole);
      setLoading(false);
    }

    // Authoritative initial resolve (validates the token with the server).
    supabase.auth.getUser().then(({ data }) => {
      if (active) sync(data.user ?? null);
    });

    // React to later auth changes: sign-in, sign-out, token refresh, and
    // cross-tab sign-out. We skip INITIAL_SESSION because getUser() above
    // already handled the first load (avoids a duplicate role fetch).
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === 'INITIAL_SESSION') return;
      sync(session?.user ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  return { user, role, isAdmin: role === 'admin', loading };
}
