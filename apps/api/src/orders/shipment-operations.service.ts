import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FedexValidationService } from './fedex-validation.service';
import { UpsShipmentService } from './ups-shipment.service';
import { getConnectorDriver } from '../connectors/connector-drivers.registry';

@Injectable()
export class ShipmentOperationsService {
  constructor(private readonly prisma: PrismaService, private readonly fedex: FedexValidationService, private readonly ups: UpsShipmentService) {}
  private async handler(id: string, operation: 'autoCreate' | 'cancel') {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { service: { include: { supplier: true } } } });
    if (!order) throw new NotFoundException('订单不存在');
    const snapshot = order.supplierRouteSnapshot as any; const supplier = order.service.supplier;
    if (snapshot?.driverCode && (snapshot.driverCode !== supplier.driverCode || snapshot.environment !== supplier.environment || snapshot.supplierId !== supplier.id || snapshot.supplierCode !== supplier.code)) throw new ConflictException('订单创建后的供应商连接或环境被修改，禁止错环境调用');
    if (!getConnectorDriver(supplier.driverCode)?.capabilities[operation]) throw new ConflictException('当前供应商尚不支持此操作');
    if (supplier.driverCode === 'UPS_OFFICIAL') return this.ups;
    if (supplier.driverCode === 'FEDEX_RELAY') return this.fedex;
    throw new ConflictException('此驱动尚未注册操作执行器');
  }
  async create(id: string, onStage?: (stage: 'VALIDATING' | 'CREATING') => Promise<void>) { return (await this.handler(id, 'autoCreate')).create(id, onStage); }
  async cancel(id: string, operatorId?: string) { return (await this.handler(id, 'cancel')).cancel(id, operatorId); }
}
