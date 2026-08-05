import { PlantLifecycle } from './PlantLifecycle';
import { BackPlate } from 'SpectaclesUIKit.lspkg/Scripts/BackPlate';

type TextLike = {
  text: string;
};

type TextRole = 'Headline1' | 'Subheadline' | 'Body' | 'Caption';
const TYPE_SCALE: Record<TextRole, number> = {
  Headline1: 27,
  Subheadline: 21,
  Body: 20,
  Caption: 18,
};
const PANEL_WIDTH_CM = 42;

@component
export class GoalLeaderboardBoard extends BaseScriptComponent {
  @input
  @allowUndefined
  leaderboardModule!: LeaderboardModule;

  @input
  leaderboardName: string = 'DeskGameDistance';

  @input('float')
  leaderboardTtlSec: number = 31536000;

  @input('int')
  usersLimit: number = 5;

  @input
  useGlobal: boolean = true;

  @input('float')
  refreshIntervalSec: number = 30;

  @input
  showCurrentUserLine: boolean = true;

  @input
  @hint('Interprets score as centimeters and displays converted distance units.')
  scoreIsCentimeters: boolean = true;

  @input
  @label('Show Kilometers')
  showKilometers: boolean = true;

  @input
  @label('Show Miles')
  showMiles: boolean = true;

  @input
  @allowUndefined
  targetText!: Text3D;

  @input
  debugLogging: boolean = false;

  private leaderboard: Leaderboard | null = null;
  private resolvingLeaderboard = false;
  private refreshCooldown = 0;
  private textTarget: TextLike | null = null;
  private missingModuleLogged = false;
  private nativeUiBuilt = false;
  private titleText: Text3D | null = null;
  private statusText: Text3D | null = null;
  private rowTexts: Text3D[] = [];
  private currentUserText: Text3D | null = null;
  private consecutiveFetchFailures = 0;

  onAwake(): void {
    this.buildNativeLeaderboardUi();
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveTextTarget();
      this.refreshLeaderboard();
      PlantLifecycle.addGoalCompleteListener((_plant) => this.refreshLeaderboardSoon(0.6));
    });

    this.createEvent('UpdateEvent').bind(() => {
      this.refreshCooldown -= getDeltaTime();
      if (this.refreshCooldown <= 0) {
        this.refreshLeaderboard();
      }
    });
  }

  private buildNativeLeaderboardUi(): void {
    if (this.nativeUiBuilt) {
      return;
    }
    this.nativeUiBuilt = true;
    const root = this.getSceneObject();
    if (isNull(root.getComponent('Component.Canvas'))) {
      root.createComponent('Component.Canvas');
    }

    let backPlate = root.getComponent(BackPlate.getTypeName()) as BackPlate;
    if (isNull(backPlate)) {
      backPlate = root.createComponent(BackPlate.getTypeName()) as BackPlate;
    }
    backPlate.style = 'default';
    backPlate.size = new vec2(PANEL_WIDTH_CM, 31);

    const content = global.scene.createSceneObject('LeaderboardContent');
    content.setParent(root);
    content.layer = root.layer;
    content.getTransform().setLocalPosition(new vec3(0, 0, 0));

    this.titleText = this.addNativeTextRow(
      content,
      'Distance Leaderboard',
      'Headline1',
      12.3,
      4.2,
      HorizontalAlignment.Center
    );
    this.addNativeTextRow(
      content,
      'GLOBAL  •  WALKING DISTANCE',
      'Caption',
      9.2,
      2.4,
      HorizontalAlignment.Center
    );
    this.addNativeTextRow(
      content,
      'RANK     PLAYER                         DISTANCE',
      'Caption',
      6.6,
      2.4,
      HorizontalAlignment.Left
    );

    const rowCount = Math.max(1, Math.min(5, Math.floor(this.usersLimit)));
    for (let i = 0; i < rowCount; i++) {
      this.rowTexts.push(
        this.addNativeTextRow(
          content,
          `${i + 1}.       —`,
          'Body',
          3.6 - i * 3.3,
          3.2,
          HorizontalAlignment.Left
        )
      );
    }

    this.currentUserText = this.addNativeTextRow(
      content,
      'YOU     Complete a distance goal to join',
      'Subheadline',
      -9.9,
      3.4,
      HorizontalAlignment.Left
    );
    this.statusText = this.addNativeTextRow(
      content,
      'Loading leaderboard…',
      'Caption',
      -13,
      2.6,
      HorizontalAlignment.Center
    );
  }

  private addNativeTextRow(
    parent: SceneObject,
    value: string,
    role: TextRole,
    localY: number,
    height: number,
    alignment: HorizontalAlignment
  ): Text3D {
    const row = global.scene.createSceneObject('LeaderboardRow');
    row.setParent(parent);
    row.layer = parent.layer;
    row.getTransform().setLocalPosition(new vec3(0, localY, 0.7));
    row.getTransform().setLocalRotation(quat.quatIdentity());
    row.getTransform().setLocalScale(vec3.one());
    const text = row.createComponent('Component.Text3D') as Text3D;
    text.text = value;
    text.size = TYPE_SCALE[role];
    text.extrusionDepth = 0.03;
    text.lineSpacing = 1;
    text.horizontalAlignment = alignment;
    text.verticalAlignment = VerticalAlignment.Center;
    text.horizontalOverflow = HorizontalOverflow.Shrink;
    text.verticalOverflow = VerticalOverflow.Overflow;
    text.worldSpaceRect = Rect.create(
      -(PANEL_WIDTH_CM - 3.2) * 0.5,
      (PANEL_WIDTH_CM - 3.2) * 0.5,
      -height * 0.5,
      height * 0.5
    );
    text.mainMaterial = (requireAsset('Text3D.mat') as Material).clone();
    text.renderOrder = 2;
    return text;
  }

  private refreshLeaderboardSoon(delaySec: number): void {
    const wait = this.createEvent('DelayedCallbackEvent');
    wait.bind(() => this.refreshLeaderboard());
    wait.reset(Math.max(0.1, delaySec));
  }

  private refreshLeaderboard(): void {
    this.refreshCooldown = Math.max(1.5, this.refreshIntervalSec);
    this.resolveLeaderboard((leaderboard) => {
      if (isNull(leaderboard)) {
        this.setStatus('Leaderboard unavailable on this platform');
        return;
      }
      this.fetchAndRender(leaderboard);
    });
  }

  private resolveLeaderboard(onResolved: (leaderboard: Leaderboard | null) => void): void {
    if (!isNull(this.leaderboard)) {
      onResolved(this.leaderboard as Leaderboard);
      return;
    }
    if (this.resolvingLeaderboard) {
      return;
    }

    const leaderboardModule = this.resolveLeaderboardModule();
    if (isNull(leaderboardModule)) {
      if (!this.missingModuleLogged) {
        this.missingModuleLogged = true;
        print('[GoalLeaderboardBoard] LeaderboardModule unavailable');
      }
      onResolved(null);
      return;
    }

    this.resolvingLeaderboard = true;
    const options = Leaderboard.CreateOptions.create();
    options.name = String(this.leaderboardName || '').trim() || 'DeskGameDistance';
    options.orderingType = Leaderboard.OrderingType.Descending;
    options.ttlSeconds = Math.max(0, Math.floor(this.leaderboardTtlSec));
    leaderboardModule.getLeaderboard(
      options,
      (leaderboard) => {
        this.resolvingLeaderboard = false;
        this.leaderboard = leaderboard;
        onResolved(leaderboard);
      },
      (message) => {
        this.resolvingLeaderboard = false;
        print(`[GoalLeaderboardBoard] getLeaderboard failed: ${String(message || 'unknown')}`);
        onResolved(null);
      }
    );
  }

  private resolveLeaderboardModule(): LeaderboardModule | null {
    if (!isNull(this.leaderboardModule)) {
      return this.leaderboardModule;
    }
    try {
      this.leaderboardModule = require(
        'LensStudio:LeaderboardModule'
      ) as LeaderboardModule;
      return this.leaderboardModule;
    } catch (error) {
      if (!this.missingModuleLogged) {
        this.missingModuleLogged = true;
        print(`[GoalLeaderboardBoard] LeaderboardModule unavailable: ${error}`);
      }
      return null;
    }
  }

  private fetchAndRender(leaderboard: Leaderboard): void {
    const options = Leaderboard.RetrievalOptions.create();
    options.usersLimit = Math.max(1, Math.min(20, Math.floor(this.usersLimit)));
    options.usersType = this.useGlobal ? Leaderboard.UsersType.Global : Leaderboard.UsersType.Friends;

    leaderboard.getLeaderboardInfo(
      options,
      (othersInfo, currentUserInfo) => {
        this.consecutiveFetchFailures = 0;
        const records = othersInfo || [];
        const lines: string[] = [];
        lines.push('Distance Leaderboard');
        lines.push('---');

        if (records.length === 0) {
          lines.push('No scores yet');
        } else {
          for (let i = 0; i < records.length; i++) {
            const row = records[i];
            lines.push(`${this.formatRank(row, i + 1)} ${this.formatName(row)} ${this.formatScore(row.score)}`);
          }
        }

        if (this.showCurrentUserLine && !isNull(currentUserInfo)) {
          lines.push('---');
          lines.push(`You: ${this.formatRank(currentUserInfo, 0)} ${this.formatScore(currentUserInfo.score)}`);
        }

        this.renderNativeRows(records, currentUserInfo);
        this.writeLegacyText(lines.join('\n'));
      },
      (status) => {
        this.consecutiveFetchFailures += 1;
        this.refreshCooldown = Math.min(
          300,
          Math.max(
            this.refreshIntervalSec,
            this.refreshIntervalSec * Math.pow(2, this.consecutiveFetchFailures)
          )
        );
        this.clearNativeRows();
        this.setStatus('Complete a distance goal to join • Snap sharing opt-in required');
        print(`[GoalLeaderboardBoard] getLeaderboardInfo failed, status: ${status}`);
      }
    );
  }

  private renderNativeRows(
    records: Leaderboard.UserRecord[],
    currentUserInfo: Leaderboard.UserRecord | null
  ): void {
    for (let i = 0; i < this.rowTexts.length; i++) {
      const text = this.rowTexts[i];
      if (i >= records.length) {
        text.text = i === 0 ? '—        No scores yet' : '';
        continue;
      }
      const record = records[i];
      text.text = `${this.formatRank(record, i + 1)}     ${this.formatName(
        record
      )}     ${this.formatScore(record.score)}`;
    }

    if (!isNull(this.currentUserText)) {
      if (this.showCurrentUserLine && !isNull(currentUserInfo)) {
        this.currentUserText.text = `YOU     ${this.formatRank(
          currentUserInfo,
          0
        )}     ${this.formatScore(currentUserInfo.score)}`;
      } else {
        this.currentUserText.text = 'YOU     Complete a distance goal to join';
      }
    }
    this.setStatus('Global scores • distance shown in km and miles');
  }

  private clearNativeRows(): void {
    for (let i = 0; i < this.rowTexts.length; i++) {
      this.rowTexts[i].text = i === 0 ? '—        Waiting for your first score' : '';
    }
    if (!isNull(this.currentUserText)) {
      this.currentUserText.text = 'YOU     Complete a distance goal to join';
    }
  }

  private setStatus(value: string): void {
    if (!isNull(this.statusText)) {
      this.statusText.text = value;
    }
    this.writeLegacyText(value);
  }

  private formatRank(row: Leaderboard.UserRecord, fallback: number): string {
    const rank = row.globalExactRank !== undefined ? row.globalExactRank : fallback;
    return `#${rank}`;
  }

  private formatName(row: Leaderboard.UserRecord): string {
    const user = row.snapchatUser;
    if (!isNull(user) && user.displayName && String(user.displayName).trim().length > 0) {
      return String(user.displayName).trim();
    }
    if (!isNull(user) && user.userName && String(user.userName).trim().length > 0) {
      return `@${String(user.userName).trim()}`;
    }
    return 'Player';
  }

  private formatScore(score: number): string {
    if (!this.scoreIsCentimeters) {
      return `${Math.round(score)} pts`;
    }
    const kilometers = Math.max(0, score) / 100000;
    const miles = kilometers * 0.621371;
    const values: string[] = [];
    if (this.showKilometers) {
      values.push(`${this.formatDistanceValue(kilometers)} km`);
    }
    if (this.showMiles) {
      values.push(`${this.formatDistanceValue(miles)} mi`);
    }
    if (values.length === 0) {
      const meters = Math.max(0, score) / 100;
      return `${meters.toFixed(1)} m`;
    }
    return values.join(' / ');
  }

  private formatDistanceValue(value: number): string {
    if (value >= 100) {
      return value.toFixed(0);
    }
    if (value >= 10) {
      return value.toFixed(1);
    }
    return value.toFixed(2);
  }

  private writeLegacyText(value: string): void {
    this.resolveTextTarget();
    if (isNull(this.textTarget) || this.textTarget.text === undefined) {
      if (this.debugLogging) {
        print(`[GoalLeaderboardBoard] ${value}`);
      }
      return;
    }
    this.textTarget.text = value;
  }

  private resolveTextTarget(): void {
    if (!isNull(this.targetText)) {
      this.textTarget = this.targetText;
      return;
    }
    if (this.nativeUiBuilt) {
      this.textTarget = null;
      return;
    }

    const root = this.getSceneObject();
    this.textTarget =
      this.findTextComponent(root) ||
      this.findText3DComponent(root);
  }

  private findTextComponent(root: SceneObject): TextLike | null {
    const text = root.getComponent('Component.Text') as Text;
    if (!isNull(text)) {
      return text;
    }
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const nested = this.findTextComponent(root.getChild(i));
      if (!isNull(nested)) {
        return nested;
      }
    }
    return null;
  }

  private findText3DComponent(root: SceneObject): TextLike | null {
    const text3d = root.getComponent('Component.Text3D') as Text3D;
    if (!isNull(text3d)) {
      return text3d;
    }
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const nested = this.findText3DComponent(root.getChild(i));
      if (!isNull(nested)) {
        return nested;
      }
    }
    return null;
  }
}
