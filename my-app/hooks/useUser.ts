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
    const fetchUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      cachedUser = user;
      setUser(user);

      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        cachedRole = data?.role || 'viewer';
        setRole(cachedRole);
      } else {
        cachedRole = null;
        setRole(null);
      }
      setLoading(false);
    };

    if (!cachedUser) {
      fetchUser();
    } else {
      setLoading(false);
    }
  }, [supabase]);

  return { user, role, isAdmin: role === 'admin', loading };
}