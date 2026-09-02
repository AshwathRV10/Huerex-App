import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Session {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  totp_enabled: boolean;
  must_change_password: boolean;
  roles: string[];
  role_names: string[];
  permissions: string[];
}

interface SessionValue {
  user: Session | null;
  loading: boolean;
  can: (perm: string) => boolean;
  canAny: (...perms: string[]) => boolean;
  refresh: () => Promise<void>;
  signIn: (username: string, password: string, totp?: string) => Promise<{ needsTotp?: boolean }>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [perms, setPerms] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const me = await api.get<Session>('/api/auth/me');
      setUser(me);
      setPerms(new Set(me.permissions));
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) { setUser(null); setPerms(new Set()); }
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const value = useMemo<SessionValue>(() => ({
    user,
    loading,
    can: (perm) => perms.has(perm),
    canAny: (...list) => list.some((p) => perms.has(p)),
    refresh: load,
    async signIn(username, password, totp) {
      const res = await api.post<{ needsTotp?: boolean; user?: Session }>('/api/auth/login',
        { username, password, ...(totp ? { totp } : {}) });
      if (res.needsTotp) return { needsTotp: true };
      if (res.user) { setUser(res.user); setPerms(new Set(res.user.permissions)); }
      return {};
    },
    async signOut() {
      await api.post('/api/auth/logout');
      setUser(null);
      setPerms(new Set());
    },
  }), [user, loading, perms, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/**
 * Hiding a control the person cannot use is a courtesy, not a control — the
 * server refuses the same call regardless. Used everywhere so screens stay
 * uncluttered rather than full of buttons that error.
 */
export function Can({ perm, any, children, fallback = null }: {
  perm?: string; any?: string[]; children: ReactNode; fallback?: ReactNode;
}) {
  const { can, canAny } = useSession();
  const ok = perm ? can(perm) : any ? canAny(...any) : true;
  return <>{ok ? children : fallback}</>;
}
