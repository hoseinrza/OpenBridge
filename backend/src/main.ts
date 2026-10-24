import 'reflect-metadata';
import './config/env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { isOriginAllowed, TRUST_PROXY } from './config/env';

async function bootstrap() {
  // rawBody is required by the LiveKit webhook: its signature covers the exact
  // bytes LiveKit sent, not the parser's re-serialization.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  if (TRUST_PROXY !== false) app.set('trust proxy', TRUST_PROXY);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    credentials: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend running → http://localhost:${port}/api`);
}
bootstrap();
