import type { AdminRole } from '@prisma/client';

export type AuthAudience = 'admin' | 'customer';

export interface AuthPrincipal {
  sub: string;
  username: string;
  audience: AuthAudience;
  roles: AdminRole[];
  customerStatus?: string;
}

