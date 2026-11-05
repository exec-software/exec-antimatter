import QRCode from 'qrcode';

const MAX_PAIRING_PAYLOAD_BYTES = 2_048;
export const MAX_PAIRING_QR_DATA_URL_LENGTH = 256 * 1_024;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/** Encodes the one-time bearer entirely in main; renderer JavaScript never receives its text. */
export async function encodePairingQrDataUrl(payload: string): Promise<string> {
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAIRING_PAYLOAD_BYTES) {
    throw new Error('Pairing payload is too large to encode safely.');
  }
  const dataUrl = await QRCode.toDataURL(payload, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
    color: {
      dark: '#111111ff',
      light: '#ffffffff',
    },
  });
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX) || dataUrl.length > MAX_PAIRING_QR_DATA_URL_LENGTH) {
    throw new Error('Pairing QR encoder returned an invalid image.');
  }
  return dataUrl;
}
