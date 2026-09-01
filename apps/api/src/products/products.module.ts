import { Module } from '@nestjs/common';
import { ProductsAdminController } from './products-admin.controller';
import { ProductsService } from './products.service';

@Module({ controllers: [ProductsAdminController], providers: [ProductsService], exports: [ProductsService] })
export class ProductsModule {}
