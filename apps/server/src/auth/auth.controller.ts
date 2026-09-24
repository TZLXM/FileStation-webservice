import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Get, Req, Res, Headers, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService, RefreshResult } from './auth.service';
import { TokenPair, ApiResponse } from '@filestation/shared';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { InitDto } from './dto/init.dto';
import { LoginDto } from './dto/login.dto';
import { Response, Request } from 'express';

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('status')
  async getStatus(): Promise<ApiResponse<{ initialized: boolean }>> {
    const initialized = await this.authService.isInitialized();
    return {
      code: 'OK',
      message: 'Success',
      data: { initialized },
      request_id: crypto.randomUUID(),
    };
  }

  @Post('init')
  @HttpCode(HttpStatus.CREATED)
  async initialize(
    @Body() body: InitDto,
    @Headers('x-init-token') initToken: string | undefined, // v1.6：从头部读取
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number }>> {
    if (!initToken) {
      throw new BadRequestException({
        code: 'MISSING_INIT_TOKEN',
        message: 'Missing X-Init-Token header',
      });
    }

    const result: TokenPair = await this.authService.initialize(body.username, body.password, initToken);

    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTIONS);

    return {
      code: 'OK',
      message: 'Initialization successful',
      data: {
        access_token: result.accessToken,
        expires_in: result.expiresIn,
      },
      request_id: crypto.randomUUID(),
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number }>> {
    const result: TokenPair = await this.authService.login(loginDto, req.ip);

    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTIONS);

    return {
      code: 'OK',
      message: 'Login successful',
      data: {
        access_token: result.accessToken,
        expires_in: result.expiresIn,
      },
      request_id: crypto.randomUUID(),
    };
  }

  @Post('api-token/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeApiToken(
    @Req() req: Request,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number }>> {
    const bearer = authorization?.match(/^Bearer[ \t]+(\S+)$/i);
    if (!bearer) throw new UnauthorizedException('Missing or invalid Bearer token');
    const result = await this.authService.exchangeApiToken(bearer[1], req.ip);
    return {
      code: 'OK',
      message: 'Token exchanged',
      data: { access_token: result.accessToken, expires_in: result.expiresIn },
      request_id: crypto.randomUUID(),
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number; username: string }>> {
    const refreshToken = req.cookies[REFRESH_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token');
    }

    const result: RefreshResult = await this.authService.refreshToken(refreshToken);

    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTIONS);

    return {
      code: 'OK',
      message: 'Token refreshed',
      data: {
        access_token: result.accessToken,
        expires_in: result.expiresIn,
        username: result.username, // v1.6：前端 checkAuth 依赖
      },
      request_id: crypto.randomUUID(),
    };
  }

  // v1.6：移除 @UseGuards(JwtAuthGuard)——access token 过期时前端必须能调 logout 清 cookie。
  // logout 只依赖 refresh_token cookie 吊销会话，无 cookie 时为幂等 no-op。
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<null>> {
    const refreshToken = req.cookies[REFRESH_COOKIE];
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }

    res.clearCookie(REFRESH_COOKIE);

    return {
      code: 'OK',
      message: 'Logged out successfully',
      data: null,
      request_id: crypto.randomUUID(),
    };
  }
}
