import { Module } from '@nestjs/common';
import { AppController } from './wrapper/app.controller';
import { AppService } from './wrapper/app.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
