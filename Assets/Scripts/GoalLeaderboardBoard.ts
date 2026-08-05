import { PlantLifecycle } from './PlantLifecycle';

type TextLike = {
  text: string;
};

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
  refreshIntervalSec: number = 4;

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

  onAwake(): void {
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

  private refreshLeaderboardSoon(delaySec: number): void {
    const wait = this.createEvent('DelayedCallbackEvent');
    wait.bind(() => this.refreshLeaderboard());
    wait.reset(Math.max(0.1, delaySec));
  }

  private refreshLeaderboard(): void {
    this.refreshCooldown = Math.max(1.5, this.refreshIntervalSec);
    this.resolveLeaderboard((leaderboard) => {
      if (isNull(leaderboard)) {
        this.writeText('Leaderboard unavailable');
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
        const lines: string[] = [];
        lines.push('Distance Leaderboard');
        lines.push('---');

        if (othersInfo.length === 0) {
          lines.push('No scores yet');
        } else {
          for (let i = 0; i < othersInfo.length; i++) {
            const row = othersInfo[i];
            lines.push(`${this.formatRank(row, i + 1)} ${this.formatName(row)} ${this.formatScore(row.score)}`);
          }
        }

        if (this.showCurrentUserLine && !isNull(currentUserInfo)) {
          lines.push('---');
          lines.push(`You: ${this.formatRank(currentUserInfo, 0)} ${this.formatScore(currentUserInfo.score)}`);
        }

        this.writeText(lines.join('\n'));
      },
      (status) => {
        this.writeText(`Leaderboard fetch failed (${status})`);
      }
    );
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

  private writeText(value: string): void {
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
