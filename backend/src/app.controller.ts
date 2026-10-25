import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private readonly prisma: PrismaService) {}

  // Liveness only: the process is up and nginx has somewhere to send traffic.
  // Named route on purpose: nginx only proxies /api/*, so a bare /api request
  // would be answered by the SPA fallback instead of the API.
  @Get('health')
  health() {
    return { status: 'ok', service: 'chatapp-backend' };
  }

  // Readiness: the instance can serve requests that need the database. A booted
  // API with an unreachable Postgres must not look healthy to the orchestrator.
  @Get('health/ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up' };
    } catch (error) {
      // The driver message can contain host names, so it stays in the log.
      this.logger.warn(`readiness probe failed: ${(error as Error)?.name ?? 'error'}`);
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
