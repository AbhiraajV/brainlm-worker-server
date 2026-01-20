#!/usr/bin/env ts-node
import prisma from '../src/prisma';

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'mock@example.com' },
    update: {},
    create: {
      id: 'mock-user-001',
      email: 'mock@example.com',
      name: 'Mock User',
    },
  });

  console.log('User ready:', user.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
