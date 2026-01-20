"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachAuth = attachAuth;
exports.requireAuth = requireAuth;
const auth_1 = require("../auth");
// Adapter: Express Request -> framework-agnostic AuthInput
function toAuthInput(req) {
    return {
        headers: req.headers,
        cookies: req.cookies ?? {},
    };
}
// Optional auth - attaches auth context, continues regardless
async function attachAuth(req, _res, next) {
    try {
        const authService = (0, auth_1.getAuthService)();
        req.auth = await authService.getAuthContext(toAuthInput(req));
        next();
    }
    catch (error) {
        next(error);
    }
}
// Required auth - returns 401 if not authenticated
// NOTE: HTTP error handling belongs HERE, not in AuthService
async function requireAuth(req, res, next) {
    try {
        const authService = (0, auth_1.getAuthService)();
        const context = await authService.getAuthContext(toAuthInput(req));
        if (!context.isAuthenticated || !context.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        req.auth = context;
        next();
    }
    catch (error) {
        res.status(401).json({ error: 'Authentication required' });
    }
}
