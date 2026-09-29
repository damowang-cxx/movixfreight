import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class OpenApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = !(exception instanceof HttpException) ? '系统暂时无法处理请求，请联系管理员并提供请求时间；不要重复创建运单' : typeof payload === 'object' && payload && 'message' in payload ? (Array.isArray(payload.message) ? payload.message.join('；') : String(payload.message)) : exception instanceof Error ? exception.message : '系统错误';
    const explicitCode = typeof payload === 'object' && payload && 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined;
    const code = explicitCode ?? (status === HttpStatus.UNAUTHORIZED ? 'API_KEY_INVALID' : status === HttpStatus.CONFLICT ? (message.includes('Idempotency-Key') ? 'IDEMPOTENCY_CONFLICT' : 'BUSINESS_CONFLICT') : status === HttpStatus.FORBIDDEN ? 'ORDER_CREATION_FORBIDDEN' : status === HttpStatus.UNPROCESSABLE_ENTITY ? 'ORDER_CREATION_REJECTED' : status === HttpStatus.BAD_REQUEST ? 'INVALID_REQUEST' : 'OPEN_API_ERROR');
    response.status(status).json({ status: 0, info: { code, message }, time: Date.now(), data: null });
  }
}
