export * from './types';
export * from './auth-service';
export { MockAuthService } from './mock-auth';

import { IAuthService } from './auth-service';
import { MockAuthService } from './mock-auth';

// Factory function - change this ONE line to swap auth providers
let authService: IAuthService | null = null;

export function getAuthService(): IAuthService {
  if (!authService) {
    // SWAP POINT: Replace MockAuthService with real implementation
    authService = new MockAuthService();
  }
  return authService;
}
