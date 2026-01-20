import { Request, Response, NextFunction } from 'express';
import { getAuthService, AuthContext, AuthInput } from '../auth';

// Extend Express Request type - attach AuthContext, not just user
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Adapter: Express Request -> framework-agnostic AuthInput
function toAuthInput(req: Request): AuthInput {
  return {
    headers: req.headers as Record<string, string>,
    cookies: req.cookies ?? {},
  };
}

// Optional auth - attaches auth context, continues regardless
export async function attachAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authService = getAuthService();
    req.auth = await authService.getAuthContext(toAuthInput(req));
    next();
  } catch (error) {
    next(error);
  }
}

// Required auth - returns 401 if not authenticated
// NOTE: HTTP error handling belongs HERE, not in AuthService
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authService = getAuthService();
    const context = await authService.getAuthContext(toAuthInput(req));

    if (!context.isAuthenticated || !context.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.auth = context;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication required' });
  }
}
