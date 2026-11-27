import { UpsOfficialConfig } from './ups-official.config';
import { UpsOfficialConnector } from './ups-official.connector';
import { Global, Module } from '@nestjs/common';
import { FedexRelayConfig } from './fedex-relay.config';
import { FedexRelayConnector } from './fedex-relay.connector';
import { FedexRelayMapper } from './fedex-relay.mapper';
import { SettingsModule } from '../settings/settings.module';
import { DpdRelayConfig } from './dpd-relay.config';
import { DpdRelayConnector } from './dpd-relay.connector';

@Global()
@Module({ imports: [SettingsModule], providers: [UpsOfficialConfig, UpsOfficialConnector, FedexRelayConfig, FedexRelayConnector, FedexRelayMapper, DpdRelayConfig, DpdRelayConnector], exports: [UpsOfficialConfig, UpsOfficialConnector, FedexRelayConfig, FedexRelayConnector, FedexRelayMapper, DpdRelayConfig, DpdRelayConnector] })
export class ConnectorsModule {}
