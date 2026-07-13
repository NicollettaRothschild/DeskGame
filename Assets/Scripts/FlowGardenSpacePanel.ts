import { SpecsApiClient, SpecsSpaceItem, SpecsSpacePanel } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';

type InteractableLike = ScriptComponent & {
  onDragUpdate?: { add: (cb: (event?: unknown) => void) => void };
  onTriggerStart?: { add: (cb: (event?: unknown) => void) => void };
};

type DragEventLike = {
  interactor?: {
    targetHitPosition?: vec3;
  };
};

@component
export class FlowGardenSpacePanel extends BaseScriptComponent {
  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  widgetParent!: SceneObject;

  @input
  @allowUndefined
  panelRoot!: SceneObject;

  @input
  @allowUndefined
  titleText3D!: Text3D;

  @input
  @allowUndefined
  bodyText3D!: Text3D;

  @input
  @allowUndefined
  imageVisual!: RenderMeshVisual;

  @input
  @allowUndefined
  statusText!: Text;

  @input
  @allowUndefined
  scrollInteractable!: ScriptComponent;

  @input('float')
  refreshIntervalSec: number = 30;

  @input('float')
  scrollDragSensitivity: number = 0.35;

  @input
  startVisible: boolean = true;

  @input
  debugLogging: boolean = true;

  @input('float')
  titleWorldScale: number = 1.2;

  @input('float')
  bodyWorldScale: number = 0.9;

  @input('float')
  maxBodyCharacters: number = 360;

  private panel: SpecsSpacePanel | null = null;
  private itemIndex = 0;
  private refreshEvent: DelayedCallbackEvent | null = null;
  private pairPollEvent: DelayedCallbackEvent | null = null;
  private scrollDragY = 0;
  private interactableBound = false;
  private imageRequestId = 0;
  private lastPairedState = false;
  private panelFixedWorldPosition: vec3 | null = null;
  private panelFixedWorldRotation: quat | null = null;
  private deskFixedParent: SceneObject | null = null;
  private panelLockEvent: UpdateEvent | null = null;

  onAwake(): void {
    this.resolvePanelRoot();
    this.disablePanelManipulation();
    this.lockPanelAtDesk();
    this.ensurePanelLockLoop();
    this.setPanelVisible(this.startVisible);
    this.createEvent('OnStartEvent').bind(() => {
      this.lockPanelAtDesk();
      this.bindScrollInteractable();
      this.applyPanelTypography();
      this.refreshPanel();
      this.scheduleRefresh();
      this.schedulePairPoll();
    });
  }

  public refreshPanel(): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.setStatus('Space panel not wired');
      return;
    }

    this.deviceRegistry.syncPairingFromStorage();
    this.lastPairedState = this.deviceRegistry.isPaired();

    if (!this.deviceRegistry.isPaired()) {
      this.renderUnpaired();
      return;
    }

    this.specsApi.fetchSpacePanel(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      (panel, error) => {
        if (!panel) {
          this.setStatus(error || 'Could not load space');
          return;
        }
        this.panel = panel;
        this.itemIndex = 0;
        this.renderCurrentItem();
        this.setStatus(`Loaded ${panel.items.length} item(s)`);
      }
    );
  }

  public appendNote(text: string, onDone?: (ok: boolean) => void): void {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    if (isNull(this.specsApi) || isNull(this.deviceRegistry) || !this.deviceRegistry.isPaired()) {
      this.setStatus('Pair at arvis.space/specs to save notes');
      if (onDone) {
        onDone(false);
      }
      return;
    }

    this.specsApi.appendSpaceNote(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      trimmed,
      (panel, error) => {
        if (!panel) {
          this.setStatus(error || 'Could not save note');
          if (onDone) {
            onDone(false);
          }
          return;
        }
        this.panel = panel;
        this.itemIndex = 0;
        this.renderCurrentItem();
        this.setStatus('Note saved to space');
        if (onDone) {
          onDone(true);
        }
      }
    );
  }

  public showPanel(): void {
    this.setPanelVisible(true);
    this.refreshPanel();
  }

  public hidePanel(): void {
    this.setPanelVisible(false);
  }

  public nextItem(): void {
    if (!this.panel || this.panel.items.length === 0) {
      return;
    }
    this.itemIndex = (this.itemIndex + 1) % this.panel.items.length;
    this.renderCurrentItem();
  }

  public previousItem(): void {
    if (!this.panel || this.panel.items.length === 0) {
      return;
    }
    this.itemIndex = (this.itemIndex - 1 + this.panel.items.length) % this.panel.items.length;
    this.renderCurrentItem();
  }

  private bindScrollInteractable(): void {
    if (this.interactableBound) {
      return;
    }

    if (isNull(this.scrollInteractable) && !isNull(this.panelRoot)) {
      const scripts = this.panelRoot.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as InteractableLike;
        if (candidate.onDragUpdate) {
          this.scrollInteractable = scripts[i];
          break;
        }
      }
    }

    if (isNull(this.scrollInteractable)) {
      return;
    }

    const interactable = this.scrollInteractable as unknown as InteractableLike;
    if (!interactable.onDragUpdate) {
      return;
    }

    this.interactableBound = true;

    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add((event?: unknown) => {
        const dragEvent = event as DragEventLike;
        const hit = dragEvent?.interactor?.targetHitPosition;
        this.scrollDragY = hit ? hit.y : 0;
      });
    }

    interactable.onDragUpdate.add((event?: unknown) => {
      const dragEvent = event as DragEventLike;
      const hit = dragEvent?.interactor?.targetHitPosition;
      if (!hit) {
        return;
      }

      const deltaY = hit.y - this.scrollDragY;
      this.scrollDragY = hit.y;
      if (Math.abs(deltaY) < this.scrollDragSensitivity) {
        return;
      }

      if (deltaY > 0) {
        this.previousItem();
      } else {
        this.nextItem();
      }
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshIntervalSec <= 0) {
      return;
    }

    this.refreshEvent = this.createEvent('DelayedCallbackEvent');
    this.refreshEvent.bind(() => {
      this.refreshPanel();
      this.scheduleRefresh();
    });
    this.refreshEvent.reset(Math.max(5, this.refreshIntervalSec));
  }

  private schedulePairPoll(): void {
    if (!isNull(this.pairPollEvent)) {
      return;
    }

    this.pairPollEvent = this.createEvent('DelayedCallbackEvent');
    this.pairPollEvent.bind(() => {
      this.pairPollEvent = null;
      this.pollPairState();
      this.schedulePairPoll();
    });
    this.pairPollEvent.reset(3);
  }

  private pollPairState(): void {
    if (isNull(this.deviceRegistry)) {
      return;
    }

    this.deviceRegistry.syncPairingFromStorage();
    const paired = this.deviceRegistry.isPaired();
    if (paired !== this.lastPairedState) {
      this.lastPairedState = paired;
      this.refreshPanel();
    }
  }

  public onDevicePaired(): void {
    this.lastPairedState = true;
    this.setPanelVisible(true);
    this.refreshPanel();
  }

  public lockAtDesk(): void {
    this.lockPanelAtDesk();
  }

  private getDeskFixedParent(): SceneObject {
    if (isNull(this.deskFixedParent)) {
      this.deskFixedParent = global.scene.createSceneObject('DeskFixedUI');
    }
    return this.deskFixedParent;
  }

  private disablePanelManipulation(): void {
    if (isNull(this.panelRoot)) {
      return;
    }

    const scripts = this.panelRoot.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
      };
      if (isNull(script) || script.manipulateRootSceneObject === undefined) {
        continue;
      }
      script.enabled = false;
    }
  }

  private ensurePanelLockLoop(): void {
    if (!isNull(this.panelLockEvent)) {
      return;
    }

    this.panelLockEvent = this.createEvent('UpdateEvent');
    this.panelLockEvent.bind(() => {
      this.enforcePanelLock();
    });
  }

  private enforcePanelLock(): void {
    if (isNull(this.panelRoot) || isNull(this.panelFixedWorldPosition)) {
      return;
    }

    const parent = this.panelRoot.getParent();
    if (!isNull(this.widgetParent) && parent === this.widgetParent) {
      this.panelRoot.setParent(this.getDeskFixedParent());
    }

    const panelTransform = this.panelRoot.getTransform();
    const worldPos = panelTransform.getWorldPosition();
    if (worldPos.distance(this.panelFixedWorldPosition) > 0.01) {
      panelTransform.setWorldPosition(this.panelFixedWorldPosition);
      if (!isNull(this.panelFixedWorldRotation)) {
        panelTransform.setWorldRotation(this.panelFixedWorldRotation);
      }
    }
  }

  private lockPanelAtDesk(): void {
    if (isNull(this.panelRoot)) {
      return;
    }

    const panelTransform = this.panelRoot.getTransform();
    if (isNull(this.panelFixedWorldPosition)) {
      this.panelFixedWorldPosition = panelTransform.getWorldPosition();
      this.panelFixedWorldRotation = panelTransform.getWorldRotation();
    }

    const parent = this.panelRoot.getParent();
    if (!isNull(this.widgetParent) && parent === this.widgetParent) {
      this.panelRoot.setParent(this.getDeskFixedParent());
    }

    panelTransform.setWorldPosition(this.panelFixedWorldPosition);
    if (!isNull(this.panelFixedWorldRotation)) {
      panelTransform.setWorldRotation(this.panelFixedWorldRotation);
    }
  }

  private resolvePanelRoot(): void {
    if (!isNull(this.panelRoot)) {
      return;
    }

    if (!isNull(this.widgetParent)) {
      const count = this.widgetParent.getChildrenCount();
      for (let i = 0; i < count; i++) {
        const child = this.widgetParent.getChild(i);
        if (!isNull(child) && String(child.name) === 'SpacePanel') {
          this.panelRoot = child;
          break;
        }
      }
    }

    if (isNull(this.panelRoot)) {
      this.panelRoot = this.getSceneObject();
    }

    this.resolvePanelVisuals();
  }

  private resolvePanelVisuals(): void {
    if (isNull(this.panelRoot)) {
      return;
    }

    if (isNull(this.titleText3D) || isNull(this.bodyText3D) || isNull(this.imageVisual)) {
      this.walkPanelVisuals(this.panelRoot);
    }
    this.applyPanelTypography();
  }

  private applyPanelTypography(): void {
    this.applyTextWorldScale(this.titleText3D, this.titleWorldScale);
    this.applyTextWorldScale(this.bodyText3D, this.bodyWorldScale);
    this.applyPanelTextPositions();
  }

  private applyPanelTextPositions(): void {
    const panelSize = this.resolvePanelBackgroundSize();
    if (!panelSize) {
      return;
    }

    const marginX = panelSize.width * 0.08;
    const marginY = panelSize.height * 0.08;
    const innerHeight = panelSize.height - marginY * 2;
    const titleBandHeight = innerHeight * 0.22;
    const titleY = panelSize.height * 0.5 - marginY - titleBandHeight * 0.5;
    const bodyY =
      panelSize.height * 0.5 -
      marginY -
      titleBandHeight -
      (innerHeight - titleBandHeight) * 0.5;

    this.setTextLocalY(this.titleText3D, titleY);
    this.setTextLocalY(this.bodyText3D, bodyY);
  }

  private resolvePanelBackgroundSize(): { width: number; height: number } | null {
    if (isNull(this.panelRoot)) {
      return null;
    }

    for (let i = 0; i < this.panelRoot.getChildrenCount(); i++) {
      const child = this.panelRoot.getChild(i);
      if (!isNull(child) && String(child.name) === 'PanelBackground') {
        const scale = child.getTransform().getLocalScale();
        return {
          width: Math.max(1, scale.x),
          height: Math.max(1, scale.y),
        };
      }
    }

    return null;
  }

  private setTextLocalY(text3d: Text3D | null, localY: number): void {
    if (isNull(text3d)) {
      return;
    }

    const textObject = text3d.getSceneObject();
    if (isNull(textObject)) {
      return;
    }

    const transform = textObject.getTransform();
    const position = transform.getLocalPosition();
    transform.setLocalPosition(new vec3(position.x, localY, position.z));
  }

  private applyTextWorldScale(text3d: Text3D | null, scale: number): void {
    if (isNull(text3d) || scale <= 0) {
      return;
    }

    const textObject = text3d.getSceneObject();
    if (isNull(textObject)) {
      return;
    }

    textObject.getTransform().setLocalScale(new vec3(scale, scale, scale));
  }

  private walkPanelVisuals(node: SceneObject): void {
    if (isNull(node)) {
      return;
    }

    const name = String(node.name || '');
    if (isNull(this.titleText3D) && name === 'SpaceTitle') {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.titleText3D = text3d as Text3D;
      }
    }
    if (isNull(this.bodyText3D) && name === 'SpaceBody') {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.bodyText3D = text3d as Text3D;
      }
    }
    if (isNull(this.imageVisual) && name === 'SpaceImage') {
      const visual = node.getComponent('Component.RenderMeshVisual');
      if (!isNull(visual)) {
        this.imageVisual = visual as RenderMeshVisual;
      }
    }

    const childCount = node.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      this.walkPanelVisuals(node.getChild(i));
    }
  }

  private setPanelVisible(visible: boolean): void {
    if (!isNull(this.panelRoot)) {
      this.panelRoot.enabled = visible;
    }
  }

  private renderUnpaired(): void {
    this.setTitle('ARVIS Space');
    this.setBody('Pair at arvis.space/specs to load your writing board, notes, and generated images.');
    this.hideImage();
    this.setStatus('Not paired');
  }

  private renderCurrentItem(): void {
    if (!this.panel) {
      this.renderUnpaired();
      return;
    }

    const items = this.panel.items;
    if (!items.length) {
      this.setTitle(this.panel.title || 'Flow Garden Board');
      this.setBody('Your space is empty. Add notes on arvis.space/spaces or say "note" plus your text.');
      this.hideImage();
      return;
    }

    const item = items[this.itemIndex] || items[0];
    const counter = `${this.itemIndex + 1}/${items.length}`;
    const typeLabel = this.formatItemType(item.type);
    this.setTitle(`${this.panel.title} · ${typeLabel} (${counter})`);
    this.setBody(this.formatItemBody(item));
    this.loadItemImage(item.imageUrl);
  }

  private formatItemType(type: string): string {
    const raw = String(type || 'item').toLowerCase();
    if (raw === 'document') return 'Doc';
    if (raw === 'image') return 'Image';
    if (raw === 'slide') return 'Slide';
    if (raw === 'zone') return 'Idea';
    return 'Note';
  }

  private formatItemBody(item: SpecsSpaceItem): string {
    const title = String(item.title || '').trim();
    const body = String(item.body || '').trim();
    let combined = '';
    if (title && body) {
      combined = `${title}\n\n${body}`;
    } else {
      combined = title || body || '(empty)';
    }

    const maxChars = Math.max(80, Math.floor(this.maxBodyCharacters));
    if (combined.length <= maxChars) {
      return combined;
    }

    return combined.slice(0, maxChars - 1) + '…';
  }

  private setTitle(value: string): void {
    if (!isNull(this.titleText3D)) {
      this.titleText3D.text = value;
    }
  }

  private setBody(value: string): void {
    if (!isNull(this.bodyText3D)) {
      this.bodyText3D.text = value;
    }
  }

  private hideImage(): void {
    if (!isNull(this.imageVisual)) {
      this.imageVisual.enabled = false;
    }
    const imageObject = !isNull(this.imageVisual) ? this.imageVisual.getSceneObject() : null;
    if (!isNull(imageObject)) {
      imageObject.enabled = false;
    }
  }

  private loadItemImage(imageUrl: string): void {
    const url = String(imageUrl || '').trim();
    if (!url || isNull(this.imageVisual)) {
      this.hideImage();
      return;
    }

    const requestId = ++this.imageRequestId;
    const remoteMediaModule = this.resolveRemoteMediaModule();
    const internetModule = this.resolveInternetModule();
    if (isNull(remoteMediaModule) || isNull(internetModule)) {
      this.hideImage();
      return;
    }

    const request = RemoteServiceHttpRequest.create();
    request.url = url;
    request.method = RemoteServiceHttpRequest.HttpRequestMethod.Get;

    internetModule.performHttpRequest(request, (response: RemoteServiceHttpResponse) => {
      if (requestId !== this.imageRequestId) {
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.hideImage();
        return;
      }

      try {
        const blob = new Blob([response.body], { type: 'image/jpeg' });
        const resource = internetModule.makeResourceFromBlob(blob);
        const loader = remoteMediaModule as RemoteMediaModule & {
          loadResourceAsImageTexture?: (
            resource: unknown,
            onSuccess: (texture: Texture) => void,
            onError: (message: string) => void
          ) => void;
        };

        if (typeof loader.loadResourceAsImageTexture !== 'function') {
          this.hideImage();
          return;
        }

        loader.loadResourceAsImageTexture(
          resource,
          (texture) => {
            if (requestId !== this.imageRequestId || isNull(this.imageVisual)) {
              return;
            }
            const material = this.imageVisual.mainMaterial;
            if (!isNull(material)) {
              material.mainPass.baseTex = texture;
            }
            const imageObject = this.imageVisual.getSceneObject();
            if (!isNull(imageObject)) {
              imageObject.enabled = true;
            }
            this.imageVisual.enabled = true;
          },
          () => {
            if (requestId === this.imageRequestId) {
              this.hideImage();
            }
          }
        );
      } catch (e) {
        if (this.debugLogging) {
          print('[SpacePanel] Image load failed: ' + e);
        }
        this.hideImage();
      }
    });
  }

  private resolveInternetModule(): InternetModule | null {
    try {
      return require('LensStudio:InternetModule') as InternetModule;
    } catch {
      return null;
    }
  }

  private resolveRemoteMediaModule(): RemoteMediaModule | null {
    try {
      return require('LensStudio:RemoteMediaModule') as RemoteMediaModule;
    } catch {
      return null;
    }
  }

  private setStatus(message: string): void {
    if (!isNull(this.statusText)) {
      this.statusText.text = message;
    }
    if (this.debugLogging) {
      print('[SpacePanel] ' + message);
    }
  }
}
