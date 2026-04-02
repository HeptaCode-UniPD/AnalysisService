import { ApiKeyGuard } from './api-key.guards';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    guard = new ApiKeyGuard();
    // Clona l'ambiente per ogni test per evitare interferenze
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Ripristina l'ambiente originale dopo tutti i test
    process.env = originalEnv;
  });

  const createMockContext = (headers: any): Partial<ExecutionContext> => ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
      }),
    } as any),
  } as any);

  it('dovrebbe essere definito', () => {
    expect(guard).toBeDefined();
  });

  it('dovrebbe lanciare UnauthorizedException se API_KEY non è configurata nel server', () => {
    delete process.env.API_KEY;
    const context = createMockContext({ 'x-api-key': 'any-key' });

    expect(() => guard.canActivate(context as ExecutionContext)).toThrow(
      new UnauthorizedException('Configurazione server mancante'),
    );
  });

  it('dovrebbe lanciare UnauthorizedException se x-api-key è mancante nella richiesta', () => {
    process.env.API_KEY = 'super-secret-key';
    const context = createMockContext({}); // Nessun header

    expect(() => guard.canActivate(context as ExecutionContext)).toThrow(
      new UnauthorizedException('API Key mancante o non valida'),
    );
  });

  it('dovrebbe lanciare UnauthorizedException se x-api-key non corrisponde', () => {
    process.env.API_KEY = 'super-secret-key';
    const context = createMockContext({ 'x-api-key': 'wrong-key' });

    expect(() => guard.canActivate(context as ExecutionContext)).toThrow(
      new UnauthorizedException('API Key mancante o non valida'),
    );
  });

  it('dovrebbe ritornare true se x-api-key è valida', () => {
    const validKey = 'valid-key-123';
    process.env.API_KEY = validKey;
    const context = createMockContext({ 'x-api-key': validKey });

    const result = guard.canActivate(context as ExecutionContext);
    expect(result).toBe(true);
  });
});
