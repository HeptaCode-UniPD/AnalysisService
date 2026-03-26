import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './wrapper/app.controller';
import { AppService } from './wrapper/app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('Test Fittizio', () => {
  it('dovrebbe passare', () => {
    expect(true).toBe(true);
  });
});

});
