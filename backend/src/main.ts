import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin:      true, // reflect request origin — lets phones/other devices on the LAN connect during dev
    credentials: true,
  });

  // Serve uploaded files statically
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend running → http://localhost:${port}/api`);
}
bootstrap();
