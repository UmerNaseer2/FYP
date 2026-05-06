// hooks/useUser.ts
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function useUser() {
  const supabase = createClient();
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        setRole(data?.role || 'viewer');
      }
      setLoading(false);
    };
    getUser();
    
  }, []);
  

  return { user, role, isAdmin: role === 'admin', loading };
}