import { describe, expect, it } from 'vitest';
import { matchesHotkey } from '../electron/hotkey';

const key = (k: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key: k,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('matchesHotkey', () => {
  it('matches a plain function key', () => {
    expect(matchesHotkey('F11', key('F11'))).toBe(true);
    expect(matchesHotkey('F11', key('F10'))).toBe(false);
  });
  it('needs the exact modifiers', () => {
    expect(matchesHotkey('Ctrl+Shift+F', key('F', { control: true, shift: true }))).toBe(true);
    expect(matchesHotkey('Ctrl+Shift+F', key('f', { control: true, shift: true }))).toBe(true);
    expect(matchesHotkey('Ctrl+Shift+F', key('F', { control: true }))).toBe(false);
    expect(matchesHotkey('F11', key('F11', { alt: true }))).toBe(false);
  });
  it('handles Enter and Space', () => {
    expect(matchesHotkey('Alt+Enter', key('Enter', { alt: true }))).toBe(true);
    expect(matchesHotkey('Ctrl+Space', key(' ', { control: true }))).toBe(true);
  });
});
