import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class OpenApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = typeof payload === 'object' && payload && 'message' in payload ? (Array.isArray(payload.message) ? payload.message.join('；') : String(payload.message)) : exception instanceof Error ? exception.message : '系统错误';
    const code = status === HttpStatus.UNAUTHORIZED ? 'API_KEY_INVALID' : status === HttpStatus.CONFLICT ? 'IDEMPOTENCY_CONFLICT' : status === HttpStatus.FORBIDDEN ? 'ORDER_CREATION_FORBIDDEN' : status === HttpStatus.UNPROCESSABLE_ENTITY ? 'ORDER_CREATION_REJECTED' : status === HttpStatus.BAD_REQUEST ? 'INVALID_REQUEST' : 'OPEN_API_ERROR';
    response.status(status).json({ status: 0, info: { code, message }, time: Date.now(), data: null });
  }
}
