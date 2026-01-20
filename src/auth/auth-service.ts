import { AuthUser, AuthContext, AuthInput } from './types';

// Framework-agnostic interface - NO Express dependency
export interface IAuthService {
  // Returns null if not authenticated
  getCurrentUser(input: AuthInput): Promise<AuthUser | null>;

  // Get full context (user + isAuthenticated flag)
  getAuthContext(input: AuthInput): Promise<AuthContext>;
}

// NOTE: No requireUser() here - HTTP errors belong in middleware, not auth domain
