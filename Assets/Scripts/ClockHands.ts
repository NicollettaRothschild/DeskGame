/**
 * Rotates the Clock hour and minute hands to match the device local time.
 * Hands keep the FBX rest pitch (X = -90°) and spin on local Y.
 *
 * This face has XII at the bottom (VI at top), so zeroOffsetDegrees defaults to 180.
 */
@component
export class ClockHands extends BaseScriptComponent {
  @input
  @allowUndefined
  hourHand!: SceneObject;

  @input
  @allowUndefined
  minuteHand!: SceneObject;

  /**
   * Degrees added after time math. 180 = XII at bottom (this mesh).
   * Use 0 if XII is at the top.
   */
  @input('float')
  zeroOffsetDegrees: number = 180;

  /** Flip if hands run counter-clockwise on this mesh. */
  @input
  invertDirection: boolean = false;

  @input
  debugLogging: boolean = false;

  private readonly basePitchDeg = -90;
  private hourTransform: Transform | null = null;
  private minuteTransform: Transform | null = null;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveHands();
      this.applyTime();
      if (this.debugLogging) {
        print('[ClockHands] started');
      }
    });

    this.createEvent('UpdateEvent').bind(() => {
      this.applyTime();
    });
  }

  private resolveHands(): void {
    if (!this.hourHand || !this.minuteHand) {
      const children = this.sceneObject.getChildrenCount();
      for (let i = 0; i < children; i++) {
        const child = this.sceneObject.getChild(i);
        const name = child.name;
        if (!this.hourHand && name === 'Hour Hand') {
          this.hourHand = child;
        } else if (!this.minuteHand && name === 'Minute Hand') {
          this.minuteHand = child;
        }
      }
    }

    this.hourTransform = this.hourHand ? this.hourHand.getTransform() : null;
    this.minuteTransform = this.minuteHand ? this.minuteHand.getTransform() : null;

    if (this.debugLogging) {
      print(
        `[ClockHands] hour=${this.hourHand ? this.hourHand.name : 'missing'} ` +
          `minute=${this.minuteHand ? this.minuteHand.name : 'missing'}`
      );
    }
  }

  private applyTime(): void {
    if (!this.hourTransform && !this.minuteTransform) {
      return;
    }

    const now = new Date();
    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours = (now.getHours() % 12) + minutes / 60;

    const dir = this.invertDirection ? -1 : 1;
    const minuteDeg = dir * minutes * 6 + this.zeroOffsetDegrees;
    const hourDeg = dir * hours * 30 + this.zeroOffsetDegrees;

    if (this.minuteTransform) {
      this.minuteTransform.setLocalRotation(
        quat.fromEulerAngles(
          this.basePitchDeg * MathUtils.DegToRad,
          minuteDeg * MathUtils.DegToRad,
          0
        )
      );
    }

    if (this.hourTransform) {
      this.hourTransform.setLocalRotation(
        quat.fromEulerAngles(
          this.basePitchDeg * MathUtils.DegToRad,
          hourDeg * MathUtils.DegToRad,
          0
        )
      );
    }
  }
}
