import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { assemble, type BlockEntry } from './assemble.ts';

const b = (name: string, version: string, text: string): BlockEntry => ({
  name,
  version,
  text,
});

Deno.test('assemble: blockVersions map matches the input list', () => {
  const out = assemble({
    systemBlocks: [b('header', 'v1.0', 'h')],
    userBlocks: [
      b('a', 'v1.0', 'A'),
      b('b', 'v2.5', 'B'),
    ],
  });
  assertEquals(out.blockVersions, {
    header: 'v1.0',
    a: 'v1.0',
    b: 'v2.5',
  });
});

Deno.test('assemble: separator defaults to \\n\\n', () => {
  const out = assemble({
    systemBlocks: [b('h', 'v1.0', 'A')],
    userBlocks: [b('x', 'v1.0', 'X'), b('y', 'v1.0', 'Y')],
  });
  assertEquals(out.userPrefix, 'X\n\nY');
  assertEquals(out.system, 'A');
});

Deno.test('assemble: custom separator overrides default', () => {
  const out = assemble({
    systemBlocks: [],
    userBlocks: [b('x', 'v1', 'X'), b('y', 'v1', 'Y')],
    separator: '\n---\n',
  });
  assertEquals(out.userPrefix, 'X\n---\nY');
});

Deno.test('assemble: empty block lists produce empty strings', () => {
  const out = assemble({ systemBlocks: [], userBlocks: [] });
  assertEquals(out.system, '');
  assertEquals(out.userPrefix, '');
  assertEquals(out.blockVersions, {});
});

Deno.test('assemble: duplicate block names — last entry wins in blockVersions', () => {
  const out = assemble({
    systemBlocks: [b('shared', 'v1.0', 'first')],
    userBlocks: [b('shared', 'v2.0', 'second')],
  });
  assertEquals(out.blockVersions['shared'], 'v2.0');
});
