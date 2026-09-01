import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './decorators';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('admin/login')
  loginAdmin(@Body() input: LoginDto) {
    return this.auth.loginAdmin(input.username, input.password);
  }

  @Post('customer/login')
  loginCustomer(@Body() input: LoginDto) {
    return this.auth.loginCustomer(input.username, input.password);
  }
}

