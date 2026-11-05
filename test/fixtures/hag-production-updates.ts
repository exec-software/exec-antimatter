/** Keep real update IPC state, suppress only its unrelated automatic background work. */
import { UpdateService as Actual } from '../../src/main/updates/service';
export * from '../../src/main/updates/service';
export class UpdateService extends Actual {
  start(): void { (globalThis as any).__hagProductionSmoke.boundaries.updaterStartupSuppressed++; }
}
