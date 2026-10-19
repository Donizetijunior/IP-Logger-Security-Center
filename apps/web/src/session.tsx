import { createContext, useContext } from 'react';
import type { Me, PublicConfig } from './types';

export const SessionContext = createContext<{ me: Me; config: PublicConfig | null } | null>(null);

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession fora do provedor');
  return v;
}
