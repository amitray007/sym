/**
 * Shared TUI chrome — Frame (bordered shell), Header, Footer, and a small
 * column Table with a selectable row. Kept presentational; screens pass data.
 */

import { Box, Text } from 'ink';

import { COLORS } from './theme.js';

/** A bordered full-width shell that wraps a screen's header + body + footer. */
export function Frame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.accent} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.accent}>
          {title}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

/** Top status line: agent reachability + total tools + the config path. */
export function Header({
  reachable,
  totalTools,
  configPath,
}: {
  reachable: boolean;
  totalTools: number;
  configPath: string;
}): React.ReactElement {
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text>
        {reachable ? (
          <Text color={COLORS.ok}>● agent up</Text>
        ) : (
          <Text color={COLORS.bad}>○ agent down</Text>
        )}
        <Text dimColor> · {totalTools} tools live</Text>
      </Text>
      <Text dimColor>{configPath}</Text>
    </Box>
  );
}

/** Keybinding hint bar, e.g. [{ key: 'a', label: 'apply' }]. */
export function Footer({ keys }: { keys: { key: string; label: string }[] }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>{keys.map((k) => `[${k.key}] ${k.label}`).join('   ')}</Text>
    </Box>
  );
}

export interface Cell {
  text: string;
  color?: string;
  dim?: boolean;
}
export interface Column {
  header: string;
  width: number;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

/** A fixed-width column table; row `selected` gets a cursor + bold. */
export function Table({
  columns,
  rows,
  selected,
}: {
  columns: Column[];
  rows: Cell[][];
  selected?: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'  '}</Text>
        {columns.map((col, i) => (
          <Text key={col.header} dimColor>
            {pad(col.header, col.width)}
            {i < columns.length - 1 ? ' ' : ''}
          </Text>
        ))}
      </Box>
      {rows.length === 0 ? (
        <Text dimColor> (none)</Text>
      ) : (
        rows.map((row, r) => {
          const isSel = r === selected;
          return (
            <Box key={r}>
              <Text {...(isSel ? { color: COLORS.accent } : {})}>{isSel ? '❯ ' : '  '}</Text>
              {row.map((cell, c) => {
                const width = columns[c]?.width ?? cell.text.length;
                const props: { color?: string; dimColor?: boolean; bold?: boolean } = {};
                if (cell.color !== undefined) props.color = cell.color;
                if (cell.dim === true) props.dimColor = true;
                if (isSel) props.bold = true;
                return (
                  <Text key={c} {...props}>
                    {pad(cell.text, width)}
                    {c < row.length - 1 ? ' ' : ''}
                  </Text>
                );
              })}
            </Box>
          );
        })
      )}
    </Box>
  );
}
