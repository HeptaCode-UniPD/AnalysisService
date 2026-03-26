import 'reflect-metadata';
import { configure } from '@vendia/serverless-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

let cachedServer: any;

export const startAnalysis = async (event: any, context: any, callback: any) => {
  if (!cachedServer) {
    const nestApp = await NestFactory.create(AppModule);
    await nestApp.init();
    
    const expressApp = nestApp.getHttpAdapter().getInstance();
    cachedServer = configure({ app: expressApp });
  }
  
  return cachedServer(event, context, callback);
};
