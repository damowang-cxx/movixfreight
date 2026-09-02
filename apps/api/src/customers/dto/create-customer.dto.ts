import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateCustomerDto {
  /**
   * 客户自行定义、系统用于稳定识别的客户 ID。
   * Prisma 内部主键仍使用 cuid，customerNo 是业务层展示和对接使用的编号。
   */
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[A-Z0-9_.-]+$/)
  customerNo!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value?.trim())
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value?.trim())
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value?.trim())
  @IsEmail()
  email?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' && !value.trim() ? undefined : value?.trim())
  @IsString()
  @MaxLength(32)
  phone?: string;
}
