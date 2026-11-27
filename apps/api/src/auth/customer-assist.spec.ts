import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminRole } from '@prisma/client';
import { AuthService } from './auth.service';
import type { AuthPrincipal } from './auth.types';
import { ADMIN_ROLES_KEY } from './decorators';
import { CustomersAdminController } from '../customers/customers-admin.controller';

const operator: AuthPrincipal = { sub: 'admin-1', username: 'operator', audience: 'admin', roles: [AdminRole.CUSTOMER_SERVICE] };
const customer = { id: 'customer-1', customerNo: 'CUS-1', username: 'client', status: 'NORMAL' };

function setup(roles: AdminRole[] = [AdminRole.CUSTOMER_SERVICE], enabled = true) {
  let signed: { principal: AuthPrincipal; options: unknown } | undefined;
  const prisma: any = {
    adminUser: { findUnique: async () => ({ id: 'admin-1', username: 'operator', enabled, roles: roles.map(role => ({ role })) }) },
    customer: { findUnique: async () => customer },
  };
  const jwt: any = { sign: (principal: AuthPrincipal, options: unknown) => { signed = { principal, options }; return 'short-lived-token'; } };
  return { service: new AuthService(prisma, jwt), signed: () => signed };
}

test('customer assistance issues a short customer-only session with the admin actor', async () => {
  const { service, signed } = setup();
  const result = await service.issueCustomerAssistToken(operator, customer.id);
  assert.equal(result.accessToken, 'short-lived-token');
  assert.equal(result.expiresInSeconds, 900);
  assert.deepEqual(signed()?.options, { expiresIn: '15m' });
  assert.deepEqual(signed()?.principal, { sub: customer.id, username: customer.username, audience: 'customer', roles: [], customerStatus: customer.status, assistedByAdminId: operator.sub, assistedByAdminUsername: operator.username });
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.deepEqual(Reflect.getMetadata(ADMIN_ROLES_KEY, CustomersAdminController.prototype.assistSession), [AdminRole.SUPER_ADMIN, AdminRole.OPERATIONS, AdminRole.CUSTOMER_SERVICE]);
});

test('customer assistance rejects disabled or unauthorized administrators', async () => {
  await assert.rejects(setup([AdminRole.FINANCE]).service.issueCustomerAssistToken(operator, customer.id), /无权协助客户/);
  await assert.rejects(setup([AdminRole.CUSTOMER_SERVICE], false).service.issueCustomerAssistToken(operator, customer.id), /无权协助客户/);
  await assert.rejects(setup().service.issueCustomerAssistToken({ ...operator, audience: 'customer' }, customer.id), /仅管理员/);
});
