import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './wrapper/app.controller';
import { AppService } from './wrapper/app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  describe('root', () => {
    it('should call getHello from service', () => {
      const result = appService.getHello();
      expect(result).toBe('Hello World!');
    });

    it('should return "Hello World!"', () => {
      jest
        .spyOn(appService, 'getHello')
        .mockImplementation(() => 'Hello World!');

      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});
