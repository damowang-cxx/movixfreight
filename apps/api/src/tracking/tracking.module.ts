import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingWorker } from './tracking.worker';
import { AdminTrackingController, CustomerTrackingController } from './tracking.controller';

@Module({ controllers: [AdminTrackingController, CustomerTrackingController], providers: [TrackingService, TrackingWorker], exports: [TrackingService] })
export class TrackingModule {}
