export const SPECS_PAIRING_URL = 'https://arvis.space/specs/';

export type SpecsPairingDisplayOptions = {
  editorMock?: boolean;
};

let specsNetworkChecked = false;
let specsNetworkAvailable = false;

export function isSpecsEditorMockActive(): boolean {
  if (!specsNetworkChecked) {
    specsNetworkChecked = true;
    try {
      RemoteServiceHttpRequest.create();
      specsNetworkAvailable = true;
    } catch {
      specsNetworkAvailable = false;
    }
  }
  return !specsNetworkAvailable;
}

export function formatSpecsPairingText3D(
  deviceId: string,
  paired: boolean,
  options?: SpecsPairingDisplayOptions
): string {
  const code = String(deviceId || 'SPEC-????').trim() || 'SPEC-????';
  if (options?.editorMock) {
    if (paired) {
      return '';
    }
    return `Editor preview\n${code}\nWebsite pairing needs Specs`;
  }
  if (paired) {
    return '';
  }
  return `Go to ${SPECS_PAIRING_URL}\n${code}`;
}

export function applySpecsPairingText3D(
  text3d: Text3D,
  deviceId: string,
  paired: boolean,
  options?: SpecsPairingDisplayOptions
): void {
  text3d.enabled = !paired;
  text3d.text = formatSpecsPairingText3D(deviceId, paired, options);
  text3d.lineSpacing = 1.15;
  text3d.size = 72;
  text3d.horizontalAlignment = HorizontalAlignment.Center;
  text3d.verticalAlignment = VerticalAlignment.Center;
}
