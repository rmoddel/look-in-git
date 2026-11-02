import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import { AppError } from './errors.js';
import type { LicenseStatus } from '../shared/types.js';

export interface LicensePolicy { productId: string; publicKey: string; trialDays: number }
interface LicensePayload { version: 1; productId: string; licenseId: string; customer: string; issuedAt: string; expiresAt?: string; deviceId?: string }
interface LicenseState { version: 1; productId: string; installationId: string; deviceId: string; trialStartedAt: string; lastSeenAt: string; license?: string }
interface Options { stateDirectory?: string; now?: () => number; deviceId?: string }
const DAY = 86_400_000, CLOCK_TOLERANCE = 300_000, STATE_LIMIT = 32 * 1024;
const devicePattern = /^[A-Za-z0-9_-]{8,128}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function invalidState() { return new AppError(409, 'LICENSE_STATE_INVALID', 'The local license state is damaged or belongs to another installation. Restore its saved copy or contact the license issuer; the trial was not reset.'); }
function currentTime(now: () => number) { const value = now(); if (!Number.isFinite(value) || value < 0 || value > 8.64e15 - DAY * 3650) throw new AppError(409, 'LICENSE_CLOCK_ERROR', 'The system clock is invalid. Correct the clock and restart Look-in-Git.'); return value; }

function decodeLicense(token: unknown, key: KeyObject, productId: string, deviceId: string, now: number): { token: string; payload: LicensePayload } {
  if (typeof token !== 'string' || token.length > 16_384) throw new AppError(400, 'LICENSE_INVALID', 'Paste a complete signed license issued for Look-in-Git.');
  const normalized = token.trim(), parts = normalized.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new AppError(400, 'LICENSE_INVALID', 'The license format is invalid. Paste the complete contents of the license file.');
  const bytes = Buffer.from(parts[0], 'base64url'), signature = Buffer.from(parts[1], 'base64url');
  if (bytes.length > 8192 || signature.length !== 64 || bytes.toString('base64url') !== parts[0] || signature.toString('base64url') !== parts[1] || !verify(null, bytes, key, signature)) throw new AppError(400, 'LICENSE_INVALID', 'The license signature is invalid. Use an unmodified license from the issuer.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new AppError(400, 'LICENSE_INVALID', 'The signed license payload is invalid.'); }
  if (!object(value) || Object.keys(value).some(name => !['version', 'productId', 'licenseId', 'customer', 'issuedAt', 'expiresAt', 'deviceId'].includes(name)) || value.version !== 1 || !text(value.productId, 80) || !text(value.licenseId, 100) || !/^[A-Za-z0-9_-]{8,100}$/.test(value.licenseId) || !text(value.customer, 200) || !timestamp(value.issuedAt) || (value.expiresAt !== undefined && !timestamp(value.expiresAt)) || (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !devicePattern.test(value.deviceId)))) throw new AppError(400, 'LICENSE_INVALID', 'The signed license has unsupported or incomplete fields.');
  const payload = value as unknown as LicensePayload;
  if (payload.productId !== productId) throw new AppError(400, 'LICENSE_WRONG_PRODUCT', 'This license was issued for a different product.');
  if (payload.deviceId && payload.deviceId !== deviceId) throw new AppError(403, 'LICENSE_WRONG_DEVICE', 'This license was issued for a different device. Give your displayed device ID to the license issuer.');
  if (Date.parse(payload.issuedAt) > now + CLOCK_TOLERANCE) throw new AppError(409, 'LICENSE_NOT_YET_VALID', 'This license was issued in the future. Check the system clock or contact the issuer.');
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) throw new AppError(400, 'LICENSE_INVALID', 'The license expiration must be after its issue date.');
  if (payload.expiresAt && now >= Date.parse(payload.expiresAt)) throw new AppError(403, 'LICENSE_EXPIRED', 'This paid license has expired. Obtain a renewed license from the issuer.');
  return { token: normalized, payload };
}

// Offline licensing is an honest convenience boundary, not anti-tampering DRM.
// A local administrator can patch the app or delete state to restart a trial.
export async function createLicenseManager(policy: LicensePolicy, options: Options = {}) {
  if (policy.productId !== 'look-in-git' || !Number.isInteger(policy.trialDays) || policy.trialDays < 1 || policy.trialDays > 3650 || typeof policy.publicKey !== 'string' || policy.publicKey.length > 8192) throw new AppError(500, 'LICENSE_POLICY_INVALID', 'This release has an invalid licensing policy. Contact the publisher.');
  let verificationKey: KeyObject;
  try { verificationKey = createPublicKey(policy.publicKey); if (verificationKey.asymmetricKeyType !== 'ed25519') throw new Error('Unsupported key'); }
  catch { throw new AppError(500, 'LICENSE_POLICY_INVALID', 'This release has an invalid verification key. Contact the publisher.'); }
  const deviceId = options.deviceId ?? createHash('sha256').update(['look-in-git', os.platform(), os.hostname(), os.homedir()].join('\0')).digest('hex').slice(0, 32);
  if (!devicePattern.test(deviceId)) throw new AppError(500, 'LICENSE_POLICY_INVALID', 'Invalid local license device identifier.');
  const stateDirectory = options.stateDirectory ?? path.join(process.env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'state')), 'Look-in-Git');
  if (!path.isAbsolute(stateDirectory)) throw new AppError(500, 'LICENSE_POLICY_INVALID', 'License state requires an absolute local folder.');
  const statePath = path.join(stateDirectory, 'license-state.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> { const result = queue.then(task, task); queue = result.catch(() => undefined); return result; }

  async function readState(time: number): Promise<LicenseState> {
    await mkdir(stateDirectory, { recursive: true });
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > STATE_LIMIT) throw invalidState();
      const handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: unknown;
      try {
        const checked = await handle.stat();
        if (!checked.isFile() || checked.size > STATE_LIMIT || checked.dev !== info.dev || checked.ino !== info.ino) throw invalidState();
        try { value = JSON.parse(await handle.readFile('utf8')); } catch { throw invalidState(); }
      } finally { await handle.close(); }
      if (!object(value) || Object.keys(value).some(name => !['version', 'productId', 'installationId', 'deviceId', 'trialStartedAt', 'lastSeenAt', 'license'].includes(name)) || value.version !== 1 || value.productId !== policy.productId || value.deviceId !== deviceId || typeof value.installationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.installationId) || !timestamp(value.trialStartedAt) || !timestamp(value.lastSeenAt) || Date.parse(value.trialStartedAt) > Date.parse(value.lastSeenAt) || (value.license !== undefined && (typeof value.license !== 'string' || !value.license || value.license.length > 16_384))) throw invalidState();
      return value as unknown as LicenseState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state: LicenseState = { version: 1, productId: policy.productId, installationId: randomUUID(), deviceId, trialStartedAt: new Date(time).toISOString(), lastSeenAt: new Date(time).toISOString() };
      try {
        await saveState(state, true);
        return state;
      } catch (creationError) { if ((creationError as NodeJS.ErrnoException).code === 'EEXIST') return readState(time); throw creationError; }
    }
  }
  async function saveState(state: LicenseState, initial = false) {
    const temporary = path.join(stateDirectory, `license-state.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
      // An exclusive hard link publishes a fully written first state without
      // replacing a concurrently created trial. Later updates use atomic rename.
      if (initial) await link(temporary, statePath);
      else await rename(temporary, statePath);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  const denied = (mode: LicenseStatus['mode'], message: string, expiresAt: string | null = null): LicenseStatus => ({ mode, allowed: false, daysRemaining: mode === 'expired' ? 0 : null, expiresAt, deviceId, message });
  function clockCheck(state: LicenseState, time: number) {
    if (Date.parse(state.lastSeenAt) - time > CLOCK_TOLERANCE) throw new AppError(409, 'LICENSE_CLOCK_ERROR', 'The clock moved backward by more than five minutes. Correct the system clock to continue; local repository data is untouched.');
  }
  function evaluate(state: LicenseState, time: number): LicenseStatus {
    clockCheck(state, time);
    if (state.license) {
      try {
        const { payload } = decodeLicense(state.license, verificationKey, policy.productId, deviceId, time);
        return { mode: 'licensed', allowed: true, daysRemaining: payload.expiresAt ? Math.ceil((Date.parse(payload.expiresAt) - time) / DAY) : null, expiresAt: payload.expiresAt ?? null, customer: payload.customer, deviceId, message: payload.expiresAt ? `Licensed to ${payload.customer}. License expires ${payload.expiresAt.slice(0, 10)}.` : `Perpetual license for ${payload.customer}.` };
      } catch (error) {
        if (error instanceof AppError && error.code === 'LICENSE_EXPIRED') {
          // Signature and schema were checked before the expiry exception.
          const payload = JSON.parse(Buffer.from(state.license.split('.')[0], 'base64url').toString('utf8')) as LicensePayload;
          return { ...denied('expired', error.message, payload.expiresAt!), customer: payload.customer };
        }
        return denied('invalid', error instanceof Error ? error.message : 'The saved license is invalid.');
      }
    }
    const end = Date.parse(state.trialStartedAt) + policy.trialDays * DAY;
    if (time >= end) return denied('expired', 'Your free trial has ended. Activate a paid license to continue. Your repositories and files are unchanged.', new Date(end).toISOString());
    return { mode: 'trial', allowed: true, daysRemaining: Math.ceil((end - time) / DAY), expiresAt: new Date(end).toISOString(), deviceId, message: `${Math.ceil((end - time) / DAY)} days remain in your free trial.` };
  }
  async function status(): Promise<LicenseStatus> {
    return serialized(async () => {
      try {
        const time = currentTime(now), state = await readState(time);
        const result = evaluate(state, time);
        if (time > Date.parse(state.lastSeenAt)) await saveState({ ...state, lastSeenAt: new Date(time).toISOString() });
        return result;
      } catch (error) {
        return denied(error instanceof AppError && error.code === 'LICENSE_CLOCK_ERROR' ? 'clock-error' : 'invalid', error instanceof AppError ? error.message : 'The local license state could not be read or saved. Check permissions on the Look-in-Git local application data folder.');
      }
    });
  }
  async function activate(token: unknown): Promise<LicenseStatus> {
    return serialized(async () => {
      try {
        const time = currentTime(now), state = await readState(time);
        clockCheck(state, time);
        const verified = decodeLicense(token, verificationKey, policy.productId, deviceId, time);
        const saved = { ...state, license: verified.token, lastSeenAt: new Date(Math.max(time, Date.parse(state.lastSeenAt))).toISOString() };
        await saveState(saved);
        return evaluate(saved, time);
      } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, 'LICENSE_STATE_IO', 'The license could not be saved. Check permissions on the Look-in-Git local application data folder.'); }
    });
  }
  await status(); // Begin the trial on first launch, even before the first browser request.
  return { status, activate };
}
