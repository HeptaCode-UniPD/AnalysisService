import 'reflect-metadata';
import { configure } from '@vendia/serverless-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ValidationPipe } from '@nestjs/common';

let cachedServer: any;

export const startAnalysis = async (
  event: any,
  context: any,
  callback: any,
) => {
  if (!cachedServer) {
    const nestApp = await NestFactory.create(AppModule);

    nestApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    await nestApp.init();

    const expressApp = nestApp.getHttpAdapter().getInstance();
    cachedServer = configure({ app: expressApp });
  }

  return cachedServer(event, context, callback);
};
