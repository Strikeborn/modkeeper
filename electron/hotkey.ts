/** "Ctrl+Shift+F", "F11", "Alt+Enter": modifiers must match exactly, the key case-insensitively. */
export function matchesHotkey(hotkey: string, input: { key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }): boolean {
  const parts = hotkey.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const want = {
    control: mods.has('ctrl') || mods.has('control'),
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    meta: mods.has('meta') || mods.has('win') || mods.has('cmd'),
  };
  if (want.control !== input.control || want.shift !== input.shift || want.alt !== input.alt || want.meta !== input.meta) return false;
  const k = input.key.toLowerCase();
  return k === key || (key === 'space' && k === ' ');
}
