// MOCK IMPLEMENTATION - Replace with real auth provider later
// This file is the ONLY thing that changes when swapping auth systems

import { IAuthService } from './auth-service';
import { AuthUser, AuthContext, AuthInput } from './types';

const MOCK_USER: AuthUser = {
  id: 'mock-user-001',
  email: 'mock@example.com',
  name: 'Mock User',
};

export class MockAuthService implements IAuthService {
  async getCurrentUser(_input: AuthInput): Promise<AuthUser | null> {
    // TODO: Replace with real auth logic
    // Real implementation would inspect input.headers['authorization']
    // or input.cookies['session'] etc.
    return MOCK_USER;
  }

  async getAuthContext(input: AuthInput): Promise<AuthContext> {
    const user = await this.getCurrentUser(input);
    return {
      user,
      isAuthenticated: user !== null,
    };
  }
}
