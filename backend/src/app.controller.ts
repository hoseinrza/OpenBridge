import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // Named route on purpose: nginx only proxies /api/*, so a bare /api request
  // would be answered by the SPA fallback instead of the API.
  @Get('health')
  health() {
    return { status: 'ok', service: 'chatapp-backend' };
  }
}
