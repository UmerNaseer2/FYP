import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { User } from '@supabase/supabase-js';

let cachedUser: User | null = null;
let cachedRole: string | null = null;

export function useUser() {
  const supabase = createClient();
  const [user, setUser] = useState<User | null>(cachedUser);
  const [role, setRole] = useState<string | null>(cachedRole);
  const [loading, setLoading] = useState(!cachedUser);

  useEffect(() => {
    // A previous mount already resolved the user — the useState initializers
    // above have seeded user/role/loading from the module cache, so there is
    // nothing left to do (and no synchronous setState to run in this effect).
    if (cachedUser) return;

    const fetchUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      cachedUser = user;
      setUser(user);

      if (user) {
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (error) {
          console.error('Error fetching role:', error.message);
          cachedRole = 'viewer';
          setRole('viewer');
        } else {
          cachedRole = data?.role || 'viewer';
          setRole(cachedRole);
        }
      } else {
        cachedRole = null;
        setRole(null);
      }
      setLoading(false);
    };

    fetchUser();
  }, [supabase]);

  return { user, role, isAdmin: role === 'admin', loading };
}