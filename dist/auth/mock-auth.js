"use strict";
// MOCK IMPLEMENTATION - Replace with real auth provider later
// This file is the ONLY thing that changes when swapping auth systems
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockAuthService = void 0;
const MOCK_USER = {
    id: 'mock-user-001',
    email: 'mock@example.com',
    name: 'Mock User',
};
class MockAuthService {
    async getCurrentUser(_input) {
        // TODO: Replace with real auth logic
        // Real implementation would inspect input.headers['authorization']
        // or input.cookies['session'] etc.
        return MOCK_USER;
    }
    async getAuthContext(input) {
        const user = await this.getCurrentUser(input);
        return {
            user,
            isAuthenticated: user !== null,
        };
    }
}
exports.MockAuthService = MockAuthService;
