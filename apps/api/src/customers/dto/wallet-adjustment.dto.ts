import { Currency } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class WalletAdjustmentDto {
  @IsEnum(Currency)
  currency!: Currency;

  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;

  @IsEnum(['CREDIT', 'DEBIT'] as const)
  direction!: 'CREDIT' | 'DEBIT';

  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  allowNegative?: boolean;
}

