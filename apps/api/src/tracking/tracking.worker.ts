import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingService } from './tracking.service';

@Injectable()
export class TrackingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly config: ConfigService, private readonly tracking: TrackingService) {}

  onModuleInit() {
    if (this.config.get<string>('DISPATCH_WORKER_ENABLED') === 'false') return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.tracking.ensureRecentTargets();
      await this.tracking.syncDue();
    } catch (error) {
      this.logger.error(`轨迹同步周期失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { this.running = false; }
  }
}
