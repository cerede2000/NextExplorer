import { describe, expect, it } from 'vitest';
import { itemExtension, terminalInputFor } from './terminalInput';

describe('opening a file in the terminal', () => {
  it('reads the extension from the name, and the kind when there is none', () => {
    expect(itemExtension({ name: 'Backup.SH' })).toBe('sh');
    expect(itemExtension({ name: 'Makefile', kind: 'makefile' })).toBe('makefile');
    expect(itemExtension({ name: '.bashrc', kind: 'directory' })).toBe('');
    expect(itemExtension({ name: 'trailing.' })).toBe('');
  });

  it('quotes a name the shell would otherwise split or expand', () => {
    expect(terminalInputFor({ name: 'run me $(now).sh' })).toBe('./run\\ me\\ \\$\\(now\\).sh');
    expect(terminalInputFor({ name: '  ' })).toBe('');
  });
});
