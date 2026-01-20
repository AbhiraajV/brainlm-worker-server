import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load .env BEFORE creating PrismaClient, override shell env vars
dotenv.config({ override: true });

const prisma = new PrismaClient();

export default prisma;
