import { Global, Module } from '@nestjs/common';
import { FedexRelayConfig } from './fedex-relay.config';
import { FedexRelayConnector } from './fedex-relay.connector';
import { FedexRelayMapper } from './fedex-relay.mapper';
import { SettingsModule } from '../settings/settings.module';

@Global()
@Module({ imports: [SettingsModule], providers: [FedexRelayConfig, FedexRelayConnector, FedexRelayMapper], exports: [FedexRelayConfig, FedexRelayConnector, FedexRelayMapper] })
export class ConnectorsModule {}
