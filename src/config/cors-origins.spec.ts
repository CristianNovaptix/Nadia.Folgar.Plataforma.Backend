import { parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('agrega puertos locales de Vite en development aunque CORS_ORIGIN venga fijo', () => {
    expect(parseCorsOrigins('http://localhost:5173', 'development')).toEqual(
      expect.arrayContaining(['http://localhost:5173', 'http://localhost:5174']),
    );
  });

  it('respeta estrictamente CORS_ORIGIN fuera de development', () => {
    expect(parseCorsOrigins('https://app.folgar.com.ar', 'production')).toEqual([
      'https://app.folgar.com.ar',
    ]);
  });
});
