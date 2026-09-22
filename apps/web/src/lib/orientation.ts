/**
 * Mobile browsers capture camera frames in the orientation of the *screen*,
 * not the phone. With auto-rotate off, a phone held sideways still sends a
 * portrait (720x1280) picture of a sideways scene. Locking the screen to
 * landscape fixes that at the source: the camera then delivers 1280x720.
 *
 * Android Chrome supports the lock, but only in fullscreen. iOS Safari supports
 * neither, so there we can only ask the user to rotate.
 */

export type Orientation = "landscape" | "portrait";

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

export function canLockOrientation(): boolean {
  const o = screen.orientation as LockableOrientation | undefined;
  return typeof o?.lock === "function" && typeof document.documentElement.requestFullscreen === "function";
}

export function currentOrientation(): Orientation {
  return window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";
}

/** Must be called from a user gesture (a tap), because fullscreen requires one. */
export async function lockOrientation(target: Orientation): Promise<boolean> {
  if (!canLockOrientation()) return false;
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
    await (screen.orientation as LockableOrientation).lock!(target);
    return true;
  } catch {
    return false;
  }
}

export async function releaseOrientation(): Promise<void> {
  try {
    (screen.orientation as LockableOrientation | undefined)?.unlock?.();
  } catch {
    /* not locked */
  }
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
}
