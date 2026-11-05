/**
 * Remote workspace IPC is an ABI shared by Electron's main and preload bundles. Keep the
 * channel names in one dependency-light module so a renderer/preload rebuild cannot silently
 * invent a method that the main process does not register.
 */
export const REMOTE_IPC = {
  state: 'remote:state',
  configure: 'remote:configure',
  createPairingOffer: 'remote:pairing-offer',
  copyPairingCode: 'remote:pairing-copy',
  cancelPairingOffer: 'remote:pairing-cancel',
  revokeDevice: 'remote:device-revoke',
} as const;

export const REMOTE_IPC_CHANNELS = Object.freeze(Object.values(REMOTE_IPC));
