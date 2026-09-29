import { Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Res, UseFilters, UseGuards, Body } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { CurrentOpenApiCustomer } from './open-api.decorators';
import { OpenApiKeyGuard, type OpenApiPrincipal } from './open-api-auth.guard';
import { OpenApiExceptionFilter } from './open-api-exception.filter';
import { OpenApiShipmentsService } from './open-api-shipments.service';
import { CreateOpenShipmentDto } from './dto/create-open-shipment.dto';
import { LabelPdfService } from '../orders/label-pdf.service';

@ApiTags('Open API v1')
@ApiHeader({ name: 'X-API-Key', required: true, description: '客户 API Key' })
@Public()
@UseGuards(OpenApiKeyGuard)
@UseFilters(OpenApiExceptionFilter)
@Controller('open/v1/shipments')
export class OpenApiShipmentsController {
  constructor(private readonly shipments: OpenApiShipmentsService, private readonly labelPdf: LabelPdfService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '客户侧唯一请求键' })
  async create(@CurrentOpenApiCustomer() customer: OpenApiPrincipal, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreateOpenShipmentDto) {
    const data = await this.shipments.create(customer, idempotencyKey, input);
    return { status: 1, info: null, time: Date.now(), data };
  }

  @Get(':shipmentId/label')
  async label(@CurrentOpenApiCustomer() customer: OpenApiPrincipal, @Param('shipmentId') shipmentId: string) {
    const data = await this.shipments.label(customer, shipmentId);
    return { status: 1, info: null, time: Date.now(), data };
  }

  @Get(':shipmentId/label/download')
  async download(@CurrentOpenApiCustomer() customer: OpenApiPrincipal, @Param('shipmentId') shipmentId: string, @Query('label_id') labelId: string | undefined, @Res() response: Response) {
    const label = await this.shipments.labelFile(customer, shipmentId, labelId);
    const type = label.contentType.toUpperCase().includes('PDF') || Buffer.from(label.content).subarray(0, 4).toString('ascii') === '%PDF' ? 'application/pdf' : 'application/octet-stream';
    const content = type === 'application/pdf' ? await this.labelPdf.forPreviewOrDownload(label.content, label.contentType, label.sourceContent ? 'UPS_OFFICIAL' : 'FEDEX_RELAY') : label.content;
    response.setHeader('Content-Type', type);
    response.setHeader('Content-Disposition', `attachment; filename="label-${label.trackingNumber ?? label.id}.${type === 'application/pdf' ? 'pdf' : 'bin'}"`);
    response.send(content);
  }
}
