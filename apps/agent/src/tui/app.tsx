/**
 * `sym` TUI root — a main menu that routes to the self-contained screens.
 *
 * Pure navigation: arrow keys (or j/k) move the cursor, Enter opens a screen,
 * q quits. Each screen does its own data loading and returns here via onBack.
 */

import { Box, Text, useApp, useInput } from 'ink';
import React, { useState } from 'react';

import { AddScreen } from './screens/AddScreen.js';
import { SecretsScreen } from './screens/SecretsScreen.js';
import { StatusScreen } from './screens/StatusScreen.js';

type Screen = 'menu' | 'status' | 'add' | 'secrets';

const ITEMS: { key: Exclude<Screen, 'menu'> | 'quit'; label: string }[] = [
  { key: 'status', label: 'Status — live connectors & tools' },
  { key: 'add', label: 'Add / replace a connector' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'quit', label: 'Quit' },
];

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('menu');
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (screen !== 'menu') return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c + ITEMS.length - 1) % ITEMS.length);
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % ITEMS.length);
    } else if (key.return) {
      const item = ITEMS[cursor];
      if (item === undefined || item.key === 'quit') exit();
      else setScreen(item.key);
    } else if (input === 'q') {
      exit();
    }
  });

  const back = (): void => setScreen('menu');
  if (screen === 'status') return <StatusScreen onBack={back} />;
  if (screen === 'add') return <AddScreen onBack={back} />;
  if (screen === 'secrets') return <SecretsScreen onBack={back} />;

  return (
    <Box flexDirection="column">
      <Text bold>sym — connector control plane</Text>
      <Box flexDirection="column" marginTop={1}>
        {ITEMS.map((item, i) => {
          const selected = i === cursor;
          return (
            <Text key={item.key} {...(selected ? { color: 'cyan' } : {})}>
              {selected ? '❯ ' : '  '}
              {item.label}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · enter select · q quit</Text>
      </Box>
    </Box>
  );
}
