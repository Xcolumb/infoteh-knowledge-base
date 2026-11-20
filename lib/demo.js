import { randomBytes } from 'node:crypto';
import config from '../config.js';

export function requireDemoEnvironment() {
  if (config.isProduction) throw new Error('Демонаполнение в production запрещено');
}

export function demoPassword(variable) {
  return process.env[variable] || randomBytes(32).toString('base64url');
}
