import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load .env BEFORE creating PrismaClient, override shell env vars
dotenv.config({ override: true });

const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
});

export default prisma;
