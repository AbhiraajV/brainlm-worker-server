export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthContext {
  user: AuthUser | null;
  isAuthenticated: boolean;
}

// Framework-agnostic input - middleware adapts req -> AuthInput
export interface AuthInput {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}
