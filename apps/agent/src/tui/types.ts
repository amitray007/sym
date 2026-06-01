/**
 * Shared contract for `sym` TUI screens.
 *
 * Each screen is a self-contained Ink component that does its own data loading
 * (via the cli/* modules) and returns to the main menu through `onBack`.
 */

export interface ScreenProps {
  /** Return to the main menu. */
  onBack: () => void;
}
