import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    // Cerchiamo l'API Key negli header della richiesta
    const apiKey = request.headers['x-api-key'];

    const validApiKey = process.env.API_KEY;

    if (!validApiKey) {
      console.error(
        "ATTENZIONE: Variabile d'ambiente API_KEY non configurata!",
      );
      throw new UnauthorizedException('Configurazione server mancante');
    }

    if (!apiKey || apiKey !== validApiKey) {
      throw new UnauthorizedException('API Key mancante o non valida');
    }

    return true;
  }
}
