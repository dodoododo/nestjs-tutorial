import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/swagger';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    setupSwagger(app);

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/hello returns English by default', async () => {
    await request(app.getHttpServer())
      .get('/api/hello')
      .expect(200)
      .expect({ message: 'Hello World!' });
  });

  it('GET /api/hello?lang=vi returns Vietnamese', async () => {
    await request(app.getHttpServer())
      .get('/api/hello?lang=vi')
      .expect(200)
      .expect({ message: 'Xin chào thế giới!' });
  });

  it('GET /api/hello with Accept-Language: vi', async () => {
    await request(app.getHttpServer())
      .get('/api/hello')
      .set('Accept-Language', 'vi')
      .expect(200)
      .expect({ message: 'Xin chào thế giới!' });
  });

  it('GET /api/hello with x-lang: vi', async () => {
    await request(app.getHttpServer())
      .get('/api/hello')
      .set('x-lang', 'vi')
      .expect(200)
      .expect({ message: 'Xin chào thế giới!' });
  });

  it('falls back to English for unsupported languages', async () => {
    await request(app.getHttpServer())
      .get('/api/hello?lang=fr')
      .expect(200)
      .expect({ message: 'Hello World!' });
  });

  it('query language takes precedence over headers', async () => {
    await request(app.getHttpServer())
      .get('/api/hello?lang=vi')
      .set('x-lang', 'en')
      .set('Accept-Language', 'en')
      .expect(200)
      .expect({ message: 'Xin chào thế giới!' });
  });

  it('GET /docs-json should expose the Hello World API', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(response.body.info.title).toBe('NestJS RealWorld Tutorial API');

    expect(response.body.paths).toHaveProperty('/api/hello');
    expect(response.body.paths['/api/hello']).toHaveProperty('get');
  });
});
