"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openai = void 0;
var openai_client_1 = require("./openai.client");
Object.defineProperty(exports, "openai", { enumerable: true, get: function () { return __importDefault(openai_client_1).default; } });
