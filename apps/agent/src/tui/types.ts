/**
 * Shared contracts for `sym` TUI screens + navigation.
 *
 * Screens are self-contained Ink components that do their own data loading
 * (via the cli/* modules + admin-client) and navigate through these callbacks.
 */

export interface ScreenProps {
  /** Return to the previous screen (the dashboard). */
  onBack: () => void;
}

export interface DashboardProps {
  /** Open the detail screen for a connector. */
  onOpen: (connector: string) => void;
  /** Open the add-connector form. */
  onAdd: () => void;
  /** Open the secrets manager. */
  onSecrets: () => void;
  /** Quit the TUI. */
  onQuit: () => void;
}

export interface DetailProps extends ScreenProps {
  /** The connector being inspected. */
  connector: string;
  /** Open the edit form pre-filled for this connector. */
  onEdit: (connector: string) => void;
}

export interface FormProps extends ScreenProps {
  /** When set, the form edits this existing connector; otherwise it adds a new one. */
  connector?: string;
}
