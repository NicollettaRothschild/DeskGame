/**
 * Rotates the Clock hour and minute hands to match the device local time.
 * Hands keep the FBX rest pitch (X = -90°) and spin on local Y.
 *
 * Clock root is rolled so XII is at the top (standard wall-clock layout).
 * invertDirection defaults true because +Y on this mesh runs counter-clockwise on the face.
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
   * Degrees added after time math. 0 = noon at XII (top after upright roll).
   */
  @input('float')
  zeroOffsetDegrees: number = 0;

  /** Flip if hands run counter-clockwise on this mesh. */
  @input
  invertDirection: boolean = true;

  @input
  debugLogging: boolean = false;

  private readonly basePitchDeg = -90;
  private hourTransform: Transform | null = null;
  private minuteTransform: Transform | null = null;
  private loggedTimeOnce = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveHands();
      this.applyTime(true);
      if (this.debugLogging) {
        print('[ClockHands] started');
      }
    });

    this.createEvent('UpdateEvent').bind(() => {
      this.applyTime(false);
    });
  }

  private resolveHands(): void {
    if (isNull(this.hourHand) || isNull(this.minuteHand)) {
      const root = this.getSceneObject();
      const children = root.getChildrenCount();
      for (let i = 0; i < children; i++) {
        const child = root.getChild(i);
        const name = child.name;
        if (isNull(this.hourHand) && name === 'Hour Hand') {
          this.hourHand = child;
        } else if (isNull(this.minuteHand) && name === 'Minute Hand') {
          this.minuteHand = child;
        }
      }
    }

    this.hourTransform = !isNull(this.hourHand) ? this.hourHand.getTransform() : null;
    this.minuteTransform = !isNull(this.minuteHand)
      ? this.minuteHand.getTransform()
      : null;

    if (this.debugLogging) {
      print(
        `[ClockHands] hour=${!isNull(this.hourHand) ? this.hourHand.name : 'missing'} ` +
          `minute=${!isNull(this.minuteHand) ? this.minuteHand.name : 'missing'}`
      );
    }
  }

  /** Device-local wall clock (hours/minutes/seconds), never UTC accessors. */
  private readLocalClock(): { hours12: number; minutes: number; seconds: number; label: string } {
    const now = new Date();
    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours24 = now.getHours();
    const hours12 = (hours24 % 12) + minutes / 60;

    let label = `${hours24}:${now.getMinutes() < 10 ? '0' : ''}${now.getMinutes()}:${
      now.getSeconds() < 10 ? '0' : ''
    }${now.getSeconds()}`;
    try {
      const localization = (global as unknown as {
        localizationSystem?: { getTimeFormatted?: (date: Date) => string };
      }).localizationSystem;
      if (!isNull(localization) && typeof localization.getTimeFormatted === 'function') {
        label = localization.getTimeFormatted(now);
      }
    } catch (_e) {
      // Preview/device without LocalizationSystem — keep Date label.
    }

    return { hours12, minutes, seconds, label };
  }

  private applyTime(forceLog: boolean): void {
    if (isNull(this.hourTransform) && isNull(this.minuteTransform)) {
      this.resolveHands();
    }
    if (isNull(this.hourTransform) && isNull(this.minuteTransform)) {
      return;
    }

    const clock = this.readLocalClock();
    const dir = this.invertDirection ? -1 : 1;
    // 6° per minute, 30° per hour on a 12-hour face.
    const minuteDeg = dir * clock.minutes * 6 + this.zeroOffsetDegrees;
    const hourDeg = dir * clock.hours12 * 30 + this.zeroOffsetDegrees;

    if (!isNull(this.minuteTransform)) {
      this.minuteTransform.setLocalRotation(
        quat.fromEulerAngles(
          this.basePitchDeg * MathUtils.DegToRad,
          minuteDeg * MathUtils.DegToRad,
          0
        )
      );
    }

    if (!isNull(this.hourTransform)) {
      this.hourTransform.setLocalRotation(
        quat.fromEulerAngles(
          this.basePitchDeg * MathUtils.DegToRad,
          hourDeg * MathUtils.DegToRad,
          0
        )
      );
    }

    if ((forceLog || !this.loggedTimeOnce) && this.debugLogging) {
      this.loggedTimeOnce = true;
      print(
        `[ClockHands] local=${clock.label} hourY=${hourDeg.toFixed(1)} minuteY=${minuteDeg.toFixed(1)} ` +
          `offset=${this.zeroOffsetDegrees} invert=${this.invertDirection}`
      );
    }
  }
}
