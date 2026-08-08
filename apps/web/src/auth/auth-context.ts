import { createContext } from 'react';
import type {
  AuthUser,
  LoginInput,
  RegisterInput,
} from './auth.types';

export type AuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  authFetch: (
    path: string,
    init?: RequestInit,
  ) => Promise<Response>;
}

export const AuthContext =
  createContext<AuthContextValue | null>(null);