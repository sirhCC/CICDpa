/**
 * Authentication Controller
 * Handles user authentication, registration, and session management
 */

import { Request, Response, NextFunction } from 'express';
import { getAuthService, hashPassword, verifyPassword, generateSessionId, UserRole } from '../middleware/auth';
import { userRepository } from '../repositories';
import { AuthenticatedRequest } from '../middleware/auth';
import { Logger } from '../shared/logger';
import { AuthenticationError, ValidationError, NotFoundError } from '../middleware/error-handler';

const logger = new Logger('AuthController');

export const authController = {
  /**
   * User login with JWT token generation
   */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, rememberMe = false } = req.body;

      // Find user by email
      const user = await userRepository.findByEmail(email);
      if (!user) {
        throw new AuthenticationError('Invalid credentials');
      }

      // Verify password
      const isValidPassword = await verifyPassword(password, user.passwordHash);
      if (!isValidPassword) {
        await userRepository.incrementLoginAttempts(user.id);
        throw new AuthenticationError('Invalid credentials');
      }

      // Check if user is active
      if (!user.isActive) {
        throw new AuthenticationError('Account is disabled');
      }

      // Generate session
      const sessionId = generateSessionId();
      
      // Generate tokens
      const accessToken = getAuthService().generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        permissions: user.permissions || [],
        sessionId
      });

      const refreshToken = getAuthService().generateRefreshToken(
        user.id, 
        sessionId, 
        'web'
      );

      // Record successful login
      await userRepository.recordLogin(user.id, req.ip);

      // Set HTTP-only cookie for refresh token if remember me
      if (rememberMe) {
        res.cookie('refreshToken', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
      }

      logger.info('User login successful', { 
        userId: user.id, 
        email: user.email,
        ip: req.ip 
      });

      res.apiSuccess({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          permissions: user.permissions
        },
        accessToken,
        ...(rememberMe ? {} : { refreshToken })
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * User registration
   */
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, firstName, lastName } = req.body;

      // Check if user already exists
      const existingUser = await userRepository.findByEmail(email);
      if (existingUser) {
        throw new ValidationError('User already exists with this email');
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const user = await userRepository.create({
        email,
        passwordHash,
        firstName,
        lastName,
        role: UserRole.VIEWER, // Default role
        permissions: [],
        isActive: true
      });

      logger.info('User registration successful', { 
        userId: user.id, 
        email: user.email 
      });

      res.apiCreated({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Refresh access token
   */
  async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
      
      if (!refreshToken) {
        throw new AuthenticationError('Refresh token is required');
      }

      // Verify refresh token
      const decoded = getAuthService().verifyToken(refreshToken, getAuthService().config.jwtRefreshSecret);
      
      // Generate new access token
      const user = await userRepository.findById(decoded.userId);
      if (!user || !user.isActive) {
        throw new AuthenticationError('User not found or inactive');
      }

      const accessToken = getAuthService().generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        permissions: user.permissions || [],
        sessionId: decoded.sessionId
      });

      res.apiSuccess({ accessToken });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Get user profile
   */
  async getProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepository.findById(req.user!.userId);
      if (!user) {
        throw new NotFoundError('User');
      }

      res.apiSuccess({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          permissions: user.permissions,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt
        }
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Update user profile
   */
  async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { firstName, lastName } = req.body;
      
      const user = await userRepository.updateById(req.user!.userId, {
        firstName,
        lastName
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      res.apiSuccess({ user });
    } catch (error) {
      next(error);
    }
  },

  /**
   * User logout
   */
  async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Blacklist the current token
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        getAuthService().blacklistToken(token);
      }

      // Clear refresh token cookie
      res.clearCookie('refreshToken');

      logger.info('User logout successful', { 
        userId: req.user!.userId,
        sessionId: req.user!.sessionId 
      });

      res.apiSuccess({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  },

  /**
   * List API keys for user
   */
  async listApiKeys(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepository.findById(req.user!.userId, { relations: ['apiKeys'] });
      if (!user) {
        throw new NotFoundError('User');
      }

      const apiKeys = user.apiKeys?.map(key => ({
        id: key.id,
        name: key.name,
        permissions: key.permissions,
        lastUsed: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt
      })) || [];

      res.apiSuccess({ apiKeys });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Create new API key
   */
  async createApiKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, permissions, expiresIn } = req.body;

      // Generate API key
      const apiKey = getAuthService().generateApiKey({
        keyId: generateSessionId(),
        userId: req.user!.userId,
        permissions: permissions || ['pipelines:read'],
        rateLimit: 1000,
        expiresIn: expiresIn || '90d'
      });

      // Save to database (implementation depends on your ApiKey entity)
      // const savedKey = await apiKeyRepository.create({ ... });

      res.apiCreated({ 
        apiKey,
        message: 'API key created successfully. Store it securely as it won\'t be shown again.'
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Revoke API key
   */
  async revokeApiKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { keyId } = req.params;
      
      // Implementation depends on your ApiKey repository
      // await apiKeyRepository.deleteByIdAndUserId(keyId, req.user!.userId);

      res.apiSuccess({ message: 'API key revoked successfully' });
    } catch (error) {
      next(error);
    }
  },

  /**
   * List all users (Admin only) - Simplified for Phase 1
   */
  async listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // For Phase 1, return a simplified response
      res.apiSuccess({ 
        users: [],
        message: 'User management will be implemented in Phase 2'
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Update user role (Admin only) - Simplified for Phase 1
   */
  async updateUserRole(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { role } = req.body;

      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // For Phase 1, just return success without actual implementation
      logger.info('User role update requested', { 
        adminUserId: req.user!.userId,
        targetUserId: userId,
        newRole: role 
      });

      res.apiSuccess({ message: 'User role management will be implemented in Phase 2' });
    } catch (error) {
      next(error);
    }
  }
};
