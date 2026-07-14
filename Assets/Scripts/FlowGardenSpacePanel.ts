import { registerFlowGardenSpacePanel } from './FlowGardenServiceRegistry';
import { SpecsApiClient, SpecsSpaceItem, SpecsSpacePanel } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';

type InteractableLike = ScriptComponent & {
  onDragUpdate?: { add: (cb: (event?: unknown) => void) => void };
  onTriggerStart?: { add: (cb: (event?: unknown) => void) => void };
};

type AgentFrameLike = ScriptComponent & {
  opacity?: number;
  cutOutCenter?: boolean;
  onInitialized?: { add: (cb: () => void) => void };
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
  agentChatRoot!: SceneObject;

  @input
  @allowUndefined
  agentChatTitleText3D!: Text3D;

  @input
  @allowUndefined
  titleText3D!: Text3D;

  @input
  @allowUndefined
  bodyText3D!: Text3D;

  @input
  @allowUndefined
  transcriptText3D!: Text3D;

  @input
  @allowUndefined
  agentResponseText3D!: Text3D;

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
  startVisible: boolean = false;

  @input
  debugLogging: boolean = false;

  @input('float')
  titleWorldScale: number = 1.2;

  @input('float')
  bodyWorldScale: number = 0.9;

  @input('float')
  maxBodyCharacters: number = 360;

  @input('float')
  speechBodyExtraOffset: number = 12;

  @input('float')
  agentChatInnerWidth: number = 32;

  @input('float')
  agentChatInnerHeight: number = 15;

  @input('float')
  agentChatBackgroundAlpha: number = 0.5;

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
  private agentViewActive = false;
  private agentChatFieldsShown = false;
  private readonly agentLegacyUiNames = ['Btn Place Plant', 'PlantBtns'];
  private agentFrameComponent: AgentFrameLike | null = null;
  private agentFrameInitBound = false;
  private agentFrameReady = false;
  private lastAppliedFrameAlpha = -1;
  private lastDebugStatus = '';
  private lastAgentChatKey = '';
  private lastSpeechTranscriptKey = '';

  onAwake(): void {
    registerFlowGardenSpacePanel(this);
    this.resolvePanelRoot();
    this.disablePanelManipulation();
    this.lockPanelAtDesk();
    this.ensurePanelLockLoop();
    this.setPanelVisible(this.startVisible);
    this.createEvent('OnStartEvent').bind(() => {
      this.lockPanelAtDesk();
      this.bindScrollInteractable();
      this.applyPanelTypography();
      this.setAgentChatFieldsVisible(false);
      this.suppressAgentLegacyUi();
      this.bindAgentFrameInitializer();
      this.refreshPanel();
      this.scheduleRefresh();
      this.schedulePairPoll();
    });
  }

  public isAgentViewActive(): boolean {
    return this.agentViewActive;
  }

  public showSpeechTranscript(liveText: string, isListening: boolean): void {
    const text = String(liveText || '').trim();
    const key = `${isListening ? 1 : 0}|${text}`;
    if (key === this.lastSpeechTranscriptKey) {
      return;
    }
    this.lastSpeechTranscriptKey = key;

    this.presentAgentChatView();

    this.setAgentTitle(isListening ? 'Speech · Listening' : 'Speech');
    this.setTranscript(text || (isListening ? '(speak now…)' : '(no speech heard)'));
    this.setAgentResponse('');
    this.setStatus(text ? (isListening ? '' : 'Heard') : '');
    this.applyAgentChatLayout();
  }

  public showAgentChat(
    transcript: string,
    response: string | null,
    agentName: string,
    phase: 'listening' | 'thinking' | 'reply' | 'error',
    imageUrl?: string | null
  ): void {
    const label = String(agentName || 'Agent').trim() || 'Agent';
    const userLine = String(transcript || '').trim();
    const replyLine = String(response || '').trim();
    const image = String(imageUrl || '').trim();
    const key = `${phase}|${label}|${userLine}|${replyLine}|${image}`;
    if (key === this.lastAgentChatKey) {
      return;
    }
    this.lastAgentChatKey = key;

    this.presentAgentChatView();

    if (phase === 'listening') {
      this.setAgentTitle(`${label} · Listening`);
      this.setTranscript(userLine || '(speak now…)');
      this.setAgentResponse('');
      this.setStatus('');
      this.applyAgentChatLayout();
      return;
    }

    if (phase === 'thinking') {
      this.setAgentTitle(`${label} · Thinking`);
      this.setTranscript(userLine || '…');
      this.setAgentResponse('…');
      this.setStatus('Thinking…');
      this.applyAgentChatLayout();
      return;
    }

    if (phase === 'error') {
      this.setAgentTitle(`${label} · Error`);
      const detail = replyLine || 'Something went wrong.';
      this.setTranscript(userLine || '');
      this.setAgentResponse(detail);
      this.setStatus(detail);
      this.applyAgentChatLayout();
      return;
    }

    this.setAgentTitle(label);
    this.setTranscript(userLine || '');
    this.setAgentResponse(this.truncateBody(replyLine || '(no response)'));
    this.setStatus('');
    this.applyAgentChatLayout();

    const url = String(imageUrl || '').trim();
    if (url) {
      this.showAgentImage(url);
    }
  }

  public showAgentImage(imageUrl: string): void {
    this.presentAgentChatView();
    const url = String(imageUrl || '').trim();
    if (!url) {
      this.hideImage();
      return;
    }
    this.loadItemImage(url);
  }

  public clearAgentView(): void {
    if (!this.agentViewActive) {
      return;
    }
    this.lastAgentChatKey = '';
    this.lastSpeechTranscriptKey = '';
    this.dismissAgentChatView();
    if (this.panel && this.panel.items.length > 0) {
      this.renderCurrentItem();
      return;
    }
    this.refreshPanel();
  }

  public refreshPanel(): void {
    if (this.agentViewActive) {
      return;
    }

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
          if (!this.agentViewActive) {
            this.setStatus(error || 'Could not load space');
          }
          return;
        }
        this.panel = panel;
        if (this.agentViewActive) {
          return;
        }
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
        if (this.agentViewActive) {
          if (onDone) {
            onDone(true);
          }
          return;
        }
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
    if (this.agentViewActive) {
      this.clearAgentView();
    }
    if (!this.panel || this.panel.items.length === 0) {
      return;
    }
    this.itemIndex = (this.itemIndex + 1) % this.panel.items.length;
    this.renderCurrentItem();
  }

  public previousItem(): void {
    if (this.agentViewActive) {
      this.clearAgentView();
    }
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
      this.enforceAgentChatPresentation();
      this.applyAgentFrameStyle();
      this.suppressAgentLegacyUi();
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

  private needsPanelVisualResolve(): boolean {
    return (
      isNull(this.titleText3D) ||
      isNull(this.bodyText3D) ||
      isNull(this.transcriptText3D) ||
      isNull(this.agentResponseText3D) ||
      isNull(this.agentChatTitleText3D) ||
      isNull(this.imageVisual)
    );
  }

  private ensurePanelVisuals(): void {
    if (!this.needsPanelVisualResolve()) {
      return;
    }
    this.resolvePanelVisuals();
  }

  private usesAgentChatContainer(): boolean {
    return !isNull(this.agentChatRoot);
  }

  private presentAgentChatView(): void {
    const entering = !this.agentViewActive;
    this.agentViewActive = true;
    if (entering) {
      this.hideImage();
      this.ensurePanelVisuals();
      this.setWoodenPanelVisible(false);
      this.setWoodenPanelContentVisible(false);
      this.setAgentChatFieldsVisible(true);
      this.agentChatFieldsShown = true;
    }
    this.applyAgentChatLayout();
  }

  private dismissAgentChatView(): void {
    this.agentViewActive = false;
    this.agentChatFieldsShown = false;
    this.setAgentChatFieldsVisible(false);
    this.setWoodenPanelContentVisible(true);
    this.setWoodenPanelVisible(this.startVisible);
  }

  private enforceAgentChatPresentation(): void {
    if (!this.agentViewActive || !this.usesAgentChatContainer()) {
      this.agentChatFieldsShown = false;
      return;
    }

    if (!isNull(this.panelRoot) && this.panelRoot.enabled) {
      this.setWoodenPanelVisible(false);
    }

    if (!this.agentChatFieldsShown) {
      this.setWoodenPanelContentVisible(false);
      this.setAgentChatFieldsVisible(true);
      this.agentChatFieldsShown = true;
    }
  }

  private setWoodenPanelContentVisible(visible: boolean): void {
    if (isNull(this.panelRoot)) {
      return;
    }

    const names = ['PanelBackground', 'SpaceTitle', 'SpaceBody', 'SpaceImage'];
    for (let i = 0; i < this.panelRoot.getChildrenCount(); i++) {
      const child = this.panelRoot.getChild(i);
      if (isNull(child)) {
        continue;
      }
      const name = String(child.name || '');
      if (names.indexOf(name) >= 0) {
        child.enabled = visible;
      }
    }
  }

  private resolvePanelVisuals(): void {
    if (isNull(this.panelRoot)) {
      return;
    }

    if (this.needsPanelVisualResolve()) {
      this.walkPanelVisuals(this.panelRoot);
      if (!isNull(this.agentChatRoot)) {
        this.walkAgentChatVisuals(this.agentChatRoot);
      }
    }

    this.applyPanelTypography();
  }

  private applyPanelTypography(): void {
    this.applyTextWorldScale(this.titleText3D, this.titleWorldScale);
    if (this.agentViewActive) {
      this.applyTextWorldScale(this.transcriptText3D, this.bodyWorldScale);
      this.applyTextWorldScale(this.agentResponseText3D, this.bodyWorldScale);
      this.applyAgentChatLayout();
      return;
    }

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

  private applyAgentChatLayout(): void {
    const panelSize = this.usesAgentChatContainer()
      ? this.resolveAgentChatFrameSize()
      : this.resolvePanelBackgroundSize();
    if (!panelSize) {
      return;
    }

    const titleText = this.usesAgentChatContainer()
      ? this.agentChatTitleText3D
      : this.titleText3D;
    const titleScale = this.usesAgentChatContainer()
      ? Math.max(0.35, this.titleWorldScale * 0.45)
      : this.titleWorldScale;
    const bodyScale = this.usesAgentChatContainer()
      ? Math.max(0.3, this.bodyWorldScale * 0.42)
      : this.bodyWorldScale;

    this.applyTextWorldScale(titleText, titleScale);
    this.applyTextWorldScale(this.transcriptText3D, bodyScale);
    this.applyTextWorldScale(this.agentResponseText3D, bodyScale);

    const marginY = panelSize.height * 0.08;
    const innerHeight = panelSize.height - marginY * 2;
    const titleBandHeight = innerHeight * 0.18;
    const titleY = panelSize.height * 0.5 - marginY - titleBandHeight * 0.5;
    const contentHeight = innerHeight - titleBandHeight;

    const gap = Math.max(0.6, contentHeight * 0.05);
    const usableHeight = Math.max(0.1, contentHeight - gap);
    const transcriptBand = usableHeight * 0.32;
    const agentBand = usableHeight - transcriptBand;
    const contentTop = panelSize.height * 0.5 - marginY - titleBandHeight;
    const extraOffset = this.usesAgentChatContainer() ? 0 : this.speechBodyExtraOffset;

    const transcriptY =
      contentTop - transcriptBand * 0.5 - gap * 0.25 - extraOffset * 0.35;
    const agentY =
      contentTop - transcriptBand - gap - agentBand * 0.5 - extraOffset * 0.15;

    this.setTextLocalY(titleText, titleY);
    this.setTextLocalY(this.transcriptText3D, transcriptY);
    this.setTextLocalY(this.agentResponseText3D, agentY);
  }

  private resolveAgentChatFrameSize(): { width: number; height: number } | null {
    if (!isNull(this.agentChatRoot)) {
      return {
        width: Math.max(1, this.agentChatInnerWidth),
        height: Math.max(1, this.agentChatInnerHeight),
      };
    }
    return this.resolvePanelBackgroundSize();
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
    if (
      isNull(this.transcriptText3D) &&
      (name === 'AITranscript' || name === 'SpaceTranscript')
    ) {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.transcriptText3D = text3d as Text3D;
      }
    }
    if (
      isNull(this.agentResponseText3D) &&
      (name === 'AIAgentResponse' || name === 'SpaceAgentResponse')
    ) {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.agentResponseText3D = text3d as Text3D;
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

  private walkAgentChatVisuals(node: SceneObject): void {
    if (isNull(node)) {
      return;
    }

    const name = String(node.name || '');
    if (isNull(this.agentChatTitleText3D) && name === 'AIChatTitle') {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.agentChatTitleText3D = text3d as Text3D;
      }
    }
    if (
      isNull(this.transcriptText3D) &&
      (name === 'AITranscript' || name === 'SpaceTranscript')
    ) {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.transcriptText3D = text3d as Text3D;
      }
    }
    if (
      isNull(this.agentResponseText3D) &&
      (name === 'AIAgentResponse' || name === 'SpaceAgentResponse')
    ) {
      const text3d = node.getComponent('Component.Text3D');
      if (!isNull(text3d)) {
        this.agentResponseText3D = text3d as Text3D;
      }
    }

    const childCount = node.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      this.walkAgentChatVisuals(node.getChild(i));
    }
  }

  private setPanelVisible(visible: boolean): void {
    this.setWoodenPanelVisible(visible);
  }

  private setWoodenPanelVisible(visible: boolean): void {
    if (!isNull(this.panelRoot)) {
      this.panelRoot.enabled = visible;
    }
  }

  private renderUnpaired(): void {
    this.dismissAgentChatView();
    this.setAgentChatFieldsVisible(false);
    this.setNotesTitle('ARVIS Space');
    this.setNotesBody('Pair at arvis.space/specs to load your writing board, notes, and generated images.');
    this.hideImage();
    this.setStatus('Not paired');
    this.setWoodenPanelVisible(this.startVisible);
    this.setWoodenPanelContentVisible(true);
    this.applyPanelTextPositions();
  }

  private renderCurrentItem(): void {
    this.setAgentChatFieldsVisible(false);
    this.setWoodenPanelVisible(this.startVisible);
    this.setWoodenPanelContentVisible(true);
    this.applyPanelTextPositions();

    if (!this.panel) {
      this.renderUnpaired();
      return;
    }

    const items = this.panel.items;
    if (!items.length) {
      this.setNotesTitle(this.panel.title || 'Flow Garden Board');
      this.setNotesBody('Your space is empty. Add notes on arvis.space/spaces or say "note" plus your text.');
      this.hideImage();
      return;
    }

    const item = items[this.itemIndex] || items[0];
    const counter = `${this.itemIndex + 1}/${items.length}`;
    const typeLabel = this.formatItemType(item.type);
    this.setNotesTitle(`${this.panel.title} · ${typeLabel} (${counter})`);
    this.setNotesBody(this.formatItemBody(item));
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

    return this.truncateBody(combined);
  }

  private truncateBody(value: string): string {
    const combined = String(value || '');
    const maxChars = Math.max(80, Math.floor(this.maxBodyCharacters));
    if (combined.length <= maxChars) {
      return combined;
    }
    return combined.slice(0, maxChars - 1) + '…';
  }

  private setNotesTitle(value: string): void {
    if (!isNull(this.titleText3D)) {
      this.titleText3D.text = value;
    }
  }

  private setAgentTitle(value: string): void {
    if (this.usesAgentChatContainer() && !isNull(this.agentChatTitleText3D)) {
      this.agentChatTitleText3D.text = value;
      return;
    }
    this.setNotesTitle(value);
  }

  private setNotesBody(value: string): void {
    if (!isNull(this.bodyText3D)) {
      this.bodyText3D.text = value;
    }
  }

  private setTitle(value: string): void {
    if (this.agentViewActive) {
      this.setAgentTitle(value);
      return;
    }
    this.setNotesTitle(value);
  }

  private setBody(value: string): void {
    this.setNotesBody(value);
  }

  private setTranscript(value: string): void {
    if (this.usesAgentChatContainer()) {
      if (!isNull(this.transcriptText3D)) {
        this.transcriptText3D.text = value;
      }
      return;
    }

    if (!isNull(this.transcriptText3D)) {
      this.transcriptText3D.text = value;
      return;
    }
    this.setNotesBody(value);
  }

  private setAgentResponse(value: string): void {
    if (!isNull(this.agentResponseText3D)) {
      this.agentResponseText3D.text = value;
    }
  }

  private setAgentChatFieldsVisible(visible: boolean): void {
    this.setTextObjectVisible(this.transcriptText3D, visible);
    this.setTextObjectVisible(this.agentResponseText3D, visible);
    this.setTextObjectVisible(this.agentChatTitleText3D, visible);
    if (visible) {
      this.setNotesBody('');
      this.setNotesTitle('');
      return;
    }

    this.setTranscript('');
    this.setAgentResponse('');
    if (!isNull(this.agentChatTitleText3D)) {
      this.agentChatTitleText3D.text = '';
    }
  }

  private setTextObjectVisible(text3d: Text3D | null, visible: boolean): void {
    if (isNull(text3d)) {
      return;
    }

    text3d.enabled = visible;
    const textObject = text3d.getSceneObject();
    if (!isNull(textObject)) {
      textObject.enabled = visible;
    }
  }

  private bindAgentFrameInitializer(): void {
    this.resolveAgentFrameComponent();
  }

  private resolveAgentFrameComponent(): AgentFrameLike | null {
    if (!isNull(this.agentFrameComponent)) {
      return this.agentFrameComponent;
    }

    if (isNull(this.agentChatRoot)) {
      return null;
    }

    const scripts = this.agentChatRoot.getComponents('Component.ScriptComponent');
    if (scripts.length === 0) {
      return null;
    }

    const script = scripts[0] as AgentFrameLike;
    if (isNull(script)) {
      return null;
    }

    this.agentFrameComponent = script;
    if (!this.agentFrameInitBound && !isNull(script.onInitialized)) {
      this.agentFrameInitBound = true;
      script.onInitialized.add(() => {
        this.agentFrameReady = true;
        this.lastAppliedFrameAlpha = -1;
        this.applyAgentFrameStyle();
      });
    }
    return script;
  }

  private applyAgentFrameStyle(): void {
    this.resolveAgentFrameComponent();
    if (!this.agentFrameReady) {
      return;
    }
    const frame = this.agentFrameComponent;
    if (isNull(frame)) {
      return;
    }

    frame.cutOutCenter = false;

    const alpha = Math.max(0, Math.min(1, this.agentChatBackgroundAlpha));
    if (alpha === this.lastAppliedFrameAlpha) {
      return;
    }
    this.lastAppliedFrameAlpha = alpha;
    frame.opacity = alpha;
  }

  private suppressAgentLegacyUi(): void {
    if (isNull(this.agentChatRoot)) {
      return;
    }

    for (let i = 0; i < this.agentChatRoot.getChildrenCount(); i++) {
      const child = this.agentChatRoot.getChild(i);
      if (isNull(child)) {
        continue;
      }
      const name = String(child.name || '');
      if (this.agentLegacyUiNames.indexOf(name) >= 0) {
        this.disableSceneObjectTree(child);
      }
    }
  }

  private disableSceneObjectTree(node: SceneObject): void {
    if (isNull(node)) {
      return;
    }

    node.enabled = false;
    for (let i = 0; i < node.getChildrenCount(); i++) {
      this.disableSceneObjectTree(node.getChild(i));
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

    if (url.startsWith('data:image/')) {
      const commaIndex = url.indexOf(',');
      const meta = commaIndex >= 0 ? url.slice(0, commaIndex) : '';
      const base64 = commaIndex >= 0 ? url.slice(commaIndex + 1) : '';
      const mimeMatch = meta.match(/^data:(image\/[a-z0-9.+-]+);base64$/i);
      const mime = mimeMatch?.[1] ? String(mimeMatch[1]) : 'image/png';
      try {
        const bytes = this.decodeBase64(base64);
        if (!bytes || bytes.length === 0) {
          this.hideImage();
          return;
        }

        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }

        const resource = (internetModule as InternetModule).makeResourceFromBlob(
          new Blob([binary], { type: mime })
        );

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
          print('[SpacePanel] Data URL image load failed: ' + e);
        }
        this.hideImage();
      }
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

  private decodeBase64(base64: string): Uint8Array | null {
    const cleaned = String(base64 || '').replace(/\s/g, '');
    if (!cleaned) {
      return null;
    }

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup: Record<string, number> = {};
    for (let i = 0; i < alphabet.length; i++) {
      lookup[alphabet.charAt(i)] = i;
    }

    const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
    const outputLength = Math.floor((cleaned.length * 3) / 4) - padding;
    const bytes = new Uint8Array(outputLength);
    let byteIndex = 0;

    for (let i = 0; i < cleaned.length; i += 4) {
      const c1 = lookup[cleaned.charAt(i)] ?? 0;
      const c2 = lookup[cleaned.charAt(i + 1)] ?? 0;
      const c3 = lookup[cleaned.charAt(i + 2)] ?? 0;
      const c4 = lookup[cleaned.charAt(i + 3)] ?? 0;

      const block = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = (block >> 16) & 0xff;
      }
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = (block >> 8) & 0xff;
      }
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = block & 0xff;
      }
    }

    return bytes;
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
    const next = String(message || '');
    if (!isNull(this.statusText)) {
      this.statusText.text = next;
    }
    if (this.debugLogging && next !== this.lastDebugStatus) {
      this.lastDebugStatus = next;
      print('[SpacePanel] ' + next);
    }
  }
}
