import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as fs from 'fs';
import { join } from 'path';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Configurazioni Swagger
  const config = new DocumentBuilder()
    .setTitle('Analysis Service MS2')
    .setDescription(
      'API per l\'analisi automatizzata di repository via AI (Docs, OWASP, Test).',
    )
    .setVersion('2.0')
    .addApiKey(
      { type: 'apiKey', name: 'x-api-key', in: 'header' },
      'x-api-key',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  
  // Scrive il file swagger.json nella root del progetto per condivisione esterna
  fs.writeFileSync(
    join(process.cwd(), 'swagger.json'),
    JSON.stringify(document, null, 2),
  );

  // Configura l'interfaccia Swagger UI locale
  SwaggerModule.setup('api/docs', app, document);

  // Abilita la validazione globale automatica
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(3000);
  console.log(`🚀 Applicazione in ascolto su: ${await app.getUrl()}`);
  console.log(`📘 Documentazione Swagger: ${await app.getUrl()}/api/docs`);
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}
