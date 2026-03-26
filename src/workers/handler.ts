import { configure } from '@vendia/serverless-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

// Manteniamo il server in cache per velocizzare le richieste successive (Cold Start optimization)
let cachedServer: any;

export const startAnalysis = async (event: any, context: any, callback: any) => {
  if (!cachedServer) {
    const nestApp = await NestFactory.create(AppModule);
    await nestApp.init();
    
    // Prende l'istanza di Express da NestJS e la passa al wrapper Serverless
    const expressApp = nestApp.getHttpAdapter().getInstance();
    cachedServer = configure({ app: expressApp });
  }
  
  return cachedServer(event, context, callback);
};