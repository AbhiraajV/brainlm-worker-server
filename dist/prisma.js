"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const dotenv_1 = __importDefault(require("dotenv"));
// Load .env BEFORE creating PrismaClient, override shell env vars
dotenv_1.default.config({ override: true });
const prisma = new client_1.PrismaClient();
exports.default = prisma;
