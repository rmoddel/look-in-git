import type { ActionRecovery } from '../shared/types.js';
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public recovery?: ActionRecovery) { super(message); }
}
