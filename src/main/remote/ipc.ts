import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { REMOTE_IPC } from '../../api/remoteIpc';
import type { RemoteWorkspaceHost } from './host';
import { encodePairingQrDataUrl, MAX_PAIRING_QR_DATA_URL_LENGTH } from './pairingQr';

export interface RemoteIpcDependencies {
  host(): RemoteWorkspaceHost;
  isAllowedSender(event: IpcMainInvokeEvent): boolean;
  writeClipboard(value: string): void;
  encodePairingQr?(value: string): Promise<string>;
}

const pairingOfferId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('Invalid pairing offer identifier.');
  }
  return value;
};

/** Registers the complete desktop Remote control surface as one tested unit. */
export function registerRemoteIpcHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: RemoteIpcDependencies
): void {
  const authorize = (event: IpcMainInvokeEvent): RemoteWorkspaceHost => {
    if (!dependencies.isAllowedSender(event)) {
      throw new Error('Remote settings are only available from the main Antimatter window.');
    }
    return dependencies.host();
  };

  ipc.handle(REMOTE_IPC.state, (event) => authorize(event).state());
  ipc.handle(
    REMOTE_IPC.configure,
    (event, patch: Parameters<RemoteWorkspaceHost['configure']>[0]) => authorize(event).configure(patch)
  );
  ipc.handle(REMOTE_IPC.createPairingOffer, async (event) => {
    const host = authorize(event);
    const offer = await host.createPairingOffer();
    const code = host.pairingCode(offer.id);
    if (!code) throw new Error('That pairing offer has expired.');
    let qrDataUrl: string;
    try {
      qrDataUrl = await (dependencies.encodePairingQr ?? encodePairingQrDataUrl)(code);
    } catch {
      host.cancelPairingOffer(offer.id);
      // Do not let a third-party encoder error echo secret input through Electron IPC.
      throw new Error('Could not create a pairing QR code. Try again.');
    }
    if (!qrDataUrl.startsWith('data:image/png;base64,') || qrDataUrl.length > MAX_PAIRING_QR_DATA_URL_LENGTH) {
      host.cancelPairingOffer(offer.id);
      throw new Error('Could not create a pairing QR code. Try again.');
    }
    // Encoding is asynchronous. Never return a QR for an offer replaced, canceled, consumed, or
    // expired while the encoder was running.
    if (host.pairingCode(offer.id) !== code) {
      host.cancelPairingOffer(offer.id);
      throw new Error('That pairing offer has expired.');
    }
    return { ...offer, qrDataUrl };
  });
  ipc.handle(REMOTE_IPC.copyPairingCode, (event, offerId: string) => {
    const code = authorize(event).pairingCode(pairingOfferId(offerId));
    if (!code) return false;
    dependencies.writeClipboard(code);
    return true;
  });
  ipc.handle(REMOTE_IPC.cancelPairingOffer, (event, offerId: string) =>
    authorize(event).cancelPairingOffer(pairingOfferId(offerId))
  );
  ipc.handle(REMOTE_IPC.revokeDevice, (event, deviceId: string) => authorize(event).revokeDevice(deviceId));
}
