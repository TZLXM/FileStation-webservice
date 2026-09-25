import { AuthController } from './auth.controller';

describe('AuthController login response', () => {
  const authService = {
    login: jest.fn(),
    verifyTotpLogin: jest.fn(),
    totpSetup: jest.fn(),
    totpConfirm: jest.fn(),
    totpDisable: jest.fn(),
  };
  const response = { cookie: jest.fn() };
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(authService as any);
  });

  it('returns a second-factor challenge without setting a refresh cookie', async () => {
    authService.login.mockResolvedValue({
      kind: 'second_factor',
      loginChallenge: 'ch-test',
      availableMethods: ['totp'],
    });

    const result = await controller.login({ username: 'admin', password: 'test-password' } as any, { ip: '127.0.0.1' } as any, response as any);

    expect(result.message).toBe('Second factor required');
    expect(Object.keys(result.data ?? {})).toEqual(['requires_second_factor', 'login_challenge', 'available_methods']);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('sets the refresh cookie only for a password-only token outcome', async () => {
    authService.login.mockResolvedValue({
      kind: 'tokens',
      tokens: { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 86400 },
    });

    const result = await controller.login({ username: 'admin', password: 'test-password' } as any, { ip: '127.0.0.1' } as any, response as any);

    expect(result.message).toBe('Login successful');
    expect('access_token' in (result.data ?? {})).toBe(true);
    if (!result.data || !('access_token' in result.data)) return;
    expect(typeof result.data.access_token).toBe('string');
    expect(response.cookie).toHaveBeenCalledTimes(1);
    expect(response.cookie.mock.calls[0][0]).toBe('refresh_token');
    expect(typeof response.cookie.mock.calls[0][1]).toBe('string');
  });
});
