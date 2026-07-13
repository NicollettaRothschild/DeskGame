export const SPECS_PAIRING_URL = 'https://arvis.space/specs/';

export function formatSpecsPairingText3D(deviceId: string, paired: boolean): string {
  const code = String(deviceId || 'SPEC-????').trim() || 'SPEC-????';
  if (paired) {
    return `Paired\n${code}`;
  }
  return `Go to ${SPECS_PAIRING_URL}\n${code}`;
}

export function applySpecsPairingText3D(text3d: Text3D, deviceId: string, paired: boolean): void {
  text3d.text = formatSpecsPairingText3D(deviceId, paired);
  text3d.lineSpacing = 1.15;
  text3d.size = 72;
  text3d.horizontalAlignment = HorizontalAlignment.Center;
  text3d.verticalAlignment = VerticalAlignment.Center;
}
