/**
 * Place Buddy / Cursor / Claude in front of the user after Spectacles 2024
 * world tracking is ready.
 *
 * Editor / Preview: keep the authored scene copies enabled so they are
 * visible in the Scene view, then move them to the camera.
 * Device: hide authored copies at boot (they must not run during
 * rotation-only VIO), then instantiate prefabs parented to this object —
 * the same instantiate(parent) path as pots / notes in this repo.
 */
import {
  getPositionInFrontOfCamera,
  isEditorRuntime,
  pickPreferredWorldCamera,
  stripLookAtOnTree,
  whenWorldSpaceReady,
} from './WorldSpaceReady';

@component
export class CompanionWorldSpawner extends BaseScriptComponent {
  @input
  @hint('Prefab captured from the scene friend / Buddy.')
  friendPrefab: ObjectPrefab | null = null;

  @input
  @hint('Prefab captured from the scene Cursor companion.')
  cursorPrefab: ObjectPrefab | null = null;

  @input
  @hint('Prefab captured from the scene Claude companion.')
  claudePrefab: ObjectPrefab | null = null;

  @input
  @hint('Authored scene Buddy. Visible in the editor; live object in Preview.')
  friendTemplate: SceneObject | null = null;

  @input
  cursorTemplate: SceneObject | null = null;

  @input
  claudeTemplate: SceneObject | null = null;

  @input
  spawnDistanceCm: number = 42;

  @input
  spawnHeightOffsetCm: number = -2;

  @input
  companionSideOffsetCm: number = 14;

  private spawned = false;
  private destroyed = false;

  onAwake(): void {
    this.destroyed = false;
    // Preview / editor: leave authored scene objects exactly where the scene
    // file put them so the Scene panel and viewport stay readable.
    if (isEditorRuntime()) {
      return;
    }

    this.hideTemplate(this.friendTemplate);
    this.hideTemplate(this.cursorTemplate);
    this.hideTemplate(this.claudeTemplate);

    this.createEvent('OnStartEvent').bind(() => {
      if (this.destroyed) {
        return;
      }
      whenWorldSpaceReady(this, () => {
        this.spawnCompanions();
      });
    });
  }

  onDestroy(): void {
    this.destroyed = true;
  }

  private hideTemplate(template: SceneObject | null): void {
    if (isNull(template)) {
      return;
    }
    template.enabled = false;
  }

  private showTemplate(template: SceneObject | null): void {
    if (isNull(template)) {
      return;
    }
    template.enabled = true;
  }

  private spawnCompanions(): void {
    if (this.spawned || this.destroyed) {
      return;
    }
    this.spawned = true;

    const camera = pickPreferredWorldCamera([]);

    this.spawnOne(
      'friend',
      this.friendPrefab,
      this.friendTemplate,
      camera,
      0,
      this.spawnHeightOffsetCm
    );

    const cursorDelay = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    cursorDelay.bind(() => {
      if (this.destroyed) {
        return;
      }
      this.spawnOne(
        'Cursor',
        this.cursorPrefab,
        this.cursorTemplate,
        camera,
        -this.companionSideOffsetCm,
        this.spawnHeightOffsetCm - 2
      );
    });
    cursorDelay.reset(0.05);

    const claudeDelay = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    claudeDelay.bind(() => {
      if (this.destroyed) {
        return;
      }
      this.spawnOne(
        'Claude',
        this.claudePrefab,
        this.claudeTemplate,
        camera,
        this.companionSideOffsetCm,
        this.spawnHeightOffsetCm - 2
      );
    });
    claudeDelay.reset(0.1);
  }

  private spawnOne(
    label: string,
    prefab: ObjectPrefab | null,
    template: SceneObject | null,
    camera: SceneObject | null,
    sideCm: number,
    heightOffsetCm: number
  ): void {
    const spawned = this.instantiatePrefab(prefab, label);
    if (!isNull(spawned)) {
      this.hideTemplate(template);
      this.placeSpawned(spawned, camera, sideCm, heightOffsetCm);
      return;
    }

    print(`[CompanionWorldSpawner] prefab spawn failed for ${label}; using authored copy`);
    this.showTemplate(template);
    this.placeSpawned(template, camera, sideCm, heightOffsetCm);
  }

  private instantiatePrefab(
    prefab: ObjectPrefab | null,
    label: string
  ): SceneObject | null {
    if (isNull(prefab)) {
      print(`[CompanionWorldSpawner] missing prefab for ${label}`);
      return null;
    }
    try {
      const parent = this.getSceneObject();
      const root = prefab.instantiate(parent);
      if (isNull(root)) {
        print(`[CompanionWorldSpawner] instantiate returned null for ${label}`);
        return null;
      }
      root.name = label;
      root.enabled = true;
      stripLookAtOnTree(root);
      print(`[CompanionWorldSpawner] spawned ${label}`);
      return root;
    } catch (error) {
      print(`[CompanionWorldSpawner] instantiate threw for ${label}: ${error}`);
      return null;
    }
  }

  private placeSpawned(
    root: SceneObject | null,
    camera: SceneObject | null,
    sideCm: number,
    heightOffsetCm: number
  ): void {
    if (isNull(root)) {
      return;
    }
    root.enabled = true;
    const position = getPositionInFrontOfCamera(
      camera,
      this.spawnDistanceCm,
      heightOffsetCm,
      sideCm
    );
    if (position === null) {
      print(
        `[CompanionWorldSpawner] no camera for ${root.name}; leaving pose ` +
          root.getTransform().getWorldPosition().toString()
      );
      return;
    }
    root.getTransform().setWorldPosition(position);
    print(
      `[CompanionWorldSpawner] placed ${root.name} world=${position.toString()}` +
        (isEditorRuntime() ? ' (editor)' : '')
    );
  }
}
