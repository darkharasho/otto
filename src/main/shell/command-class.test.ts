import { describe, it, expect } from 'vitest';
import { classify, denyMatch } from './command-class';

describe('classify', () => {
  const reads: string[] = [
    'ls',
    'ls -la',
    'cat foo.txt',
    'grep -r foo .',
    'find . -type f',
    'head -n 20 a.log',
    'tail -n 50 b.log',
    'wc -l c.txt',
    'pwd',
    'which node',
    'echo hello',
    'printf "%s\n" hi',
    'date',
    'whoami',
    'id',
    'uname -a',
    'ps aux',
    'top -bn1',
    'df -h',
    'du -sh .',
    'stat foo.txt',
    'file bar',
    'git status',
    'git log --oneline -5',
    'git diff',
    'git show HEAD',
    'git branch',
    'git remote -v',
    'git rev-parse HEAD',
    'sudo ls',
    'env FOO=bar ls',
    'nice -n 5 grep foo .',
  ];
  for (const cmd of reads) {
    it(`'${cmd}' -> read`, () => {
      expect(classify(cmd)).toBe('read');
    });
  }

  const irreversible: string[] = [
    'rm -rf foo',
    'rm -R bar',
    'dd if=foo of=/dev/sdb',
    'mkfs.ext4 /dev/sdb1',
    'mkfs -t ext4 /dev/sdb1',
  ];
  for (const cmd of irreversible) {
    it(`'${cmd}' -> irreversible`, () => {
      expect(classify(cmd)).toBe('irreversible');
    });
  }

  const destructive: string[] = [
    'npm install',
    'mv a b',
    'chmod 777 foo',
    'rm foo.txt',
    'tail -f log.txt',
    'curl https://example.com',
  ];
  for (const cmd of destructive) {
    it(`'${cmd}' -> destructive`, () => {
      expect(classify(cmd)).toBe('destructive');
    });
  }
});

describe('denyMatch', () => {
  const hard: Array<[string, string]> = [
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf --no-preserve-root /', 'rm-rf-root'],
    [':(){ :|:& };:', 'fork-bomb'],
    ['chmod -R 000 /', 'chmod-root'],
    ['chmod -R 00 /', 'chmod-root'],
  ];
  for (const [cmd, name] of hard) {
    it(`'${cmd}' -> hard/${name}`, () => {
      expect(denyMatch(cmd)).toEqual({ tier: 'hard', name });
    });
  }

  const confirm: Array<[string, string]> = [
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd-to-block-device'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['sudo mkfs.exfat -n STORAGE /dev/sda1 && echo "---DONE---"', 'mkfs'],
    ['mkfs -t ext4 /dev/sda1', 'mkfs'],
    ['shred -vfz /dev/sda', 'shred-device'],
    ['echo X > /dev/sdc', 'redirect-to-block-device'],
  ];
  for (const [cmd, name] of confirm) {
    it(`'${cmd}' -> confirm/${name}`, () => {
      expect(denyMatch(cmd)).toEqual({ tier: 'confirm', name });
    });
  }

  const allowed: string[] = ['ls', 'rm file.txt', 'dd if=foo of=bar', 'chmod 644 file.txt'];
  for (const cmd of allowed) {
    it(`'${cmd}' -> null`, () => {
      expect(denyMatch(cmd)).toBeNull();
    });
  }

  it('a command matching both tiers gets the hard tier', () => {
    expect(denyMatch('mkfs.ext4 /dev/sda1 && rm -rf /')).toEqual({
      tier: 'hard',
      name: 'rm-rf-root',
    });
  });
});
