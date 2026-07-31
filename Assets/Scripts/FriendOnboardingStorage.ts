/** Persistent flag: user finished Friend onboarding at least once. */
export const FRIEND_ONBOARDING_COMPLETED_KEY = 'friend_onboarding_completed';

export function isFriendOnboardingCompletedInStorage(): boolean {
  try {
    const store = global.persistentStorageSystem.store;
    return (
      store.has(FRIEND_ONBOARDING_COMPLETED_KEY) &&
      store.getBool(FRIEND_ONBOARDING_COMPLETED_KEY)
    );
  } catch (_e) {
    return false;
  }
}

export function markFriendOnboardingCompletedInStorage(): void {
  try {
    const store = global.persistentStorageSystem.store;
    store.putBool(FRIEND_ONBOARDING_COMPLETED_KEY, true);
    print('[FriendOnboarding] marked complete in persistent storage');
  } catch (e) {
    print('[FriendOnboarding] failed to persist complete flag: ' + e);
  }
}

export function clearFriendOnboardingCompletedInStorage(): void {
  try {
    const store = global.persistentStorageSystem.store;
    store.putBool(FRIEND_ONBOARDING_COMPLETED_KEY, false);
    store.remove(FRIEND_ONBOARDING_COMPLETED_KEY);
    print('[FriendOnboarding] completion flag cleared');
  } catch (e) {
    print('[FriendOnboarding] failed to clear complete flag: ' + e);
  }
}

/**
 * True when the tour should run this session.
 * @param treatAsNewUser When true, ignore completion storage and always run (dev / QA).
 */
export function shouldRunFriendOnboardingTour(
  enableOnboardingFlag: boolean,
  treatAsNewUser: boolean = false
): boolean {
  if (!enableOnboardingFlag) {
    return false;
  }
  if (treatAsNewUser) {
    return true;
  }
  return !isFriendOnboardingCompletedInStorage();
}
