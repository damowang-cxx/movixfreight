import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  // 客户用户名可为中文展示名，例如“甲方”，因此不能沿用旧的 3 字符限制。
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
