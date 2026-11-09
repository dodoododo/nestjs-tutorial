import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/hello should return Hello World', async () => {
    await request(app.getHttpServer()).get('/api/hello').expect(200).expect({
      message: 'Hello World!',
    });
  });
});
