/**
 * `sym` TUI root — a Dashboard-home router. The Dashboard is the landing
 * screen; it navigates into per-connector detail, the add/edit builder, and the
 * secrets manager. Each screen returns home via onBack.
 */

import { useApp } from 'ink';
import { useState } from 'react';

import { BuilderScreen } from './screens/BuilderScreen.js';
import { Dashboard } from './screens/Dashboard.js';
import { DetailScreen } from './screens/DetailScreen.js';
import { SecretsManager } from './screens/SecretsManager.js';

type Screen =
  | { name: 'dashboard' }
  | { name: 'detail'; connector: string }
  | { name: 'add' }
  | { name: 'edit'; connector: string }
  | { name: 'secrets' };

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const home = (): void => setScreen({ name: 'dashboard' });

  switch (screen.name) {
    case 'detail':
      return (
        <DetailScreen
          connector={screen.connector}
          onBack={home}
          onEdit={(connector) => setScreen({ name: 'edit', connector })}
        />
      );
    case 'add':
      return <BuilderScreen onBack={home} />;
    case 'edit':
      return <BuilderScreen connector={screen.connector} onBack={home} />;
    case 'secrets':
      return <SecretsManager onBack={home} />;
    case 'dashboard':
    default:
      return (
        <Dashboard
          onOpen={(connector) => setScreen({ name: 'detail', connector })}
          onAdd={() => setScreen({ name: 'add' })}
          onSecrets={() => setScreen({ name: 'secrets' })}
          onQuit={() => exit()}
        />
      );
  }
}
