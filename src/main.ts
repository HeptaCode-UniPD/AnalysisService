import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Abilita la validazione globale automatica
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Rimuove eventuali campi in più inviati dal client non presenti nel DTO
      forbidNonWhitelisted: true, // Blocca la richiesta se ci sono campi extra
    }),
  );

  await app.listen(3000);
  console.log(`🚀 Applicazione in ascolto su: ${await app.getUrl()}`);
}
bootstrap();
