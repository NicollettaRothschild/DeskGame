import { applySpecsPairingText3D, SPECS_PAIRING_URL } from './SpecsPairingDisplay';

const STORAGE_DEVICE_ID = 'specs_device_id';
const STORAGE_DEVICE_SECRET = 'specs_device_secret';
const STORAGE_PAIRED = 'specs_device_paired';

@component
export class SpecsDeviceRegistry extends BaseScriptComponent {
  @input
  @allowUndefined
  statusText!: Text;

  @input
  @allowUndefined
  userIdText3D!: Text3D;

  @input
  debugLogging: boolean = true;

  private deviceId = '';
  private deviceSecret = '';
  private paired = false;
  private pairSyncEvent: DelayedCallbackEvent | null = null;

  onAwake(): void {
    this.resolveUserIdText3D();
    this.loadFromStorage();
    if (!this.deviceId) {
      this.deviceId = this.generateDeviceId();
      this.saveToStorage();
    }
    this.refreshStatusText();
    this.schedulePairingSync();
  }

  public syncPairingFromStorage(): boolean {
    const store = global.persistentStorageSystem.store;
    const storedPaired = store.getBool(STORAGE_PAIRED);
    if (storedPaired === this.paired) {
      return false;
    }

    this.paired = storedPaired;
    this.refreshStatusText();
    return true;
  }

  private schedulePairingSync(): void {
    if (!isNull(this.pairSyncEvent)) {
      return;
    }

    this.pairSyncEvent = this.createEvent('DelayedCallbackEvent');
    this.pairSyncEvent.bind(() => {
      this.pairSyncEvent = null;
      this.syncPairingFromStorage();
      this.schedulePairingSync();
    });
    this.pairSyncEvent.reset(2);
  }

  public getDeviceId(): string {
    return this.deviceId;
  }

  public getDeviceSecret(): string {
    return this.deviceSecret;
  }

  public isPaired(): boolean {
    return this.paired;
  }

  public setPaired(paired: boolean): void {
    this.paired = paired;
    global.persistentStorageSystem.store.putBool(STORAGE_PAIRED, paired);
    this.refreshStatusText();
  }

  public applyRegistration(deviceId: string, deviceSecret: string, paired: boolean): void {
    this.deviceId = deviceId;
    this.deviceSecret = deviceSecret;
    this.paired = paired;
    this.saveToStorage();
    this.refreshStatusText();
  }

  public getPairingUrl(baseUrl: string): string {
    return SPECS_PAIRING_URL;
  }

  private generateDeviceId(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 8; i++) {
      const index = Math.floor(Math.random() * alphabet.length);
      suffix += alphabet.charAt(index);
    }
    return 'SPEC-' + suffix;
  }

  private loadFromStorage(): void {
    const store = global.persistentStorageSystem.store;
    this.deviceId = String(store.getString(STORAGE_DEVICE_ID) || '').trim();
    this.deviceSecret = String(store.getString(STORAGE_DEVICE_SECRET) || '').trim();
    this.paired = store.getBool(STORAGE_PAIRED);
  }

  private saveToStorage(): void {
    const store = global.persistentStorageSystem.store;
    store.putString(STORAGE_DEVICE_ID, this.deviceId);
    store.putString(STORAGE_DEVICE_SECRET, this.deviceSecret);
    store.putBool(STORAGE_PAIRED, this.paired);
  }

  private refreshStatusText(): void {
    const displayId = this.deviceId || 'SPEC-????';

    const text3d = this.resolveUserIdText3D();
    if (!isNull(text3d)) {
      applySpecsPairingText3D(text3d as Text3D, displayId, this.paired);
    }

    if (!isNull(this.statusText)) {
      const pairHint = this.paired ? 'paired' : SPECS_PAIRING_URL;
      this.statusText.text = `Specs ID: ${displayId}\n${pairHint}`;
    }

    if (this.debugLogging) {
      print(`[SpecsDevice] ${displayId} paired=${this.paired}`);
    }
  }

  private resolveUserIdText3D(): Text3D | null {
    if (!isNull(this.userIdText3D)) {
      return this.userIdText3D;
    }

    const localText3d = this.getSceneObject().getComponent('Component.Text3D');
    if (!isNull(localText3d)) {
      this.userIdText3D = localText3d as Text3D;
      return this.userIdText3D;
    }

    const byName = this.findText3DByObjectNames(['Text3D UserID', 'UserID', 'Text3D_UserID']);
    if (!isNull(byName)) {
      this.userIdText3D = byName;
    }
    return byName;
  }

  private findText3DByObjectNames(names: string[]): Text3D | null {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const stack: SceneObject[] = [];
    const visited = new Set<SceneObject>();

    let root = this.getSceneObject();
    while (!isNull(root) && !isNull(root.getParent())) {
      root = root.getParent();
    }
    if (!isNull(root)) {
      stack.push(root);
    }

    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current) || visited.has(current)) {
        continue;
      }
      visited.add(current);

      if (wanted.has(String(current.name).toLowerCase())) {
        const text3d = current.getComponent('Component.Text3D');
        if (!isNull(text3d)) {
          return text3d as Text3D;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }
}
