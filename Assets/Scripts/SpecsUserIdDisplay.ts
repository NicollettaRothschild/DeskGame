import { applySpecsPairingText3D } from './SpecsPairingDisplay';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';

const STORAGE_DEVICE_ID = 'specs_device_id';

/**
 * Attach this script to the "Text3D UserID" scene object.
 * Shows pairing URL + device code on that Text3D.
 */
@component
export class SpecsUserIdDisplay extends BaseScriptComponent {
  @input
  @allowUndefined
  userIdText3D!: Text3D;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  debugLogging: boolean = true;

  private refreshEvent: DelayedCallbackEvent | null = null;

  onAwake(): void {
    this.bindLocalText3D();
    this.ensureDeviceId();
    this.createEvent('OnStartEvent').bind(() => {
      this.refreshFromRegistry();
      this.scheduleRefresh();
    });
  }

  private bindLocalText3D(): void {
    if (!isNull(this.userIdText3D)) {
      return;
    }

    const localText3d = this.getSceneObject().getComponent('Component.Text3D');
    if (!isNull(localText3d)) {
      this.userIdText3D = localText3d as Text3D;
    }
  }

  private ensureDeviceId(): string {
    const store = global.persistentStorageSystem.store;
    let deviceId = String(store.getString(STORAGE_DEVICE_ID) || '').trim();
    if (!deviceId) {
      deviceId = this.generateDeviceId();
      store.putString(STORAGE_DEVICE_ID, deviceId);
    }
    return deviceId;
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

  private scheduleRefresh(): void {
    if (!isNull(this.refreshEvent)) {
      return;
    }

    this.refreshEvent = this.createEvent('DelayedCallbackEvent');
    this.refreshEvent.bind(() => {
      this.refreshEvent = null;
      this.refreshFromRegistry();
      this.scheduleRefresh();
    });
    this.refreshEvent.reset(2);
  }

  private refreshFromRegistry(): void {
    if (isNull(this.userIdText3D)) {
      if (this.debugLogging) {
        print('[SpecsUserIdDisplay] No Text3D component found on this object.');
      }
      return;
    }

    if (!isNull(this.deviceRegistry)) {
      this.deviceRegistry.syncPairingFromStorage();
    }

    const deviceId = !isNull(this.deviceRegistry)
      ? this.deviceRegistry.getDeviceId()
      : this.ensureDeviceId();
    const paired = !isNull(this.deviceRegistry)
      ? this.deviceRegistry.isPaired()
      : false;

    applySpecsPairingText3D(this.userIdText3D as Text3D, deviceId, paired);

    if (this.debugLogging) {
      print(`[SpecsUserIdDisplay] ${deviceId} paired=${paired}`);
    }
  }
}
