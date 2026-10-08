import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activationFilePaths,
  writeActivationPlan,
} from '../src/enable-banking/activation-files.js';

const directories: string[] = [];
async function fixture(): Promise<{
  root: string;
  cwd: string;
  statement: string;
  output: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cfo-activation-files-'));
  directories.push(directory);
  const root = join(directory, 'repository');
  const cwd = join(root, 'apps', 'worker');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  const statement = join(directory, 'synthetic-statement');
  await writeFile(statement, 'synthetic fixture', { mode: 0o600 });
  return { root, cwd, statement, output: join(directory, 'plan.json') };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Stage 8.7 protected activation files', () => {
  it('creates a new external mode-0600 plan from the worker working directory', async () => {
    const { cwd, statement, output } = await fixture();
    const paths = await activationFilePaths(cwd, statement, output);
    await writeActivationPlan(paths.output, '{"synthetic":true}');
    expect(await readFile(output, 'utf8')).toBe('{"synthetic":true}\n');
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
  });

  it('rejects statement and output paths elsewhere inside the workspace', async () => {
    const { root, cwd, statement, output } = await fixture();
    const internalStatement = join(root, 'docs', 'statement');
    await writeFile(internalStatement, 'synthetic fixture', { mode: 0o600 });
    await expect(activationFilePaths(cwd, internalStatement, output)).rejects.toThrow(
      'statement must remain outside',
    );
    await expect(
      activationFilePaths(cwd, statement, join(root, 'docs', 'plan.json')),
    ).rejects.toThrow('plan must remain outside');
  });

  it('resolves symlinked inputs and output parents before containment checks', async () => {
    const { root, cwd, statement, output } = await fixture();
    const internal = join(root, 'docs', 'statement');
    await writeFile(internal, 'synthetic fixture', { mode: 0o600 });
    const alias = `${statement}-alias`;
    await symlink(internal, alias);
    await expect(activationFilePaths(cwd, alias, output)).rejects.toThrow(
      'statement must remain outside',
    );
    const parentAlias = `${output}-parent`;
    await symlink(join(root, 'docs'), parentAlias);
    await expect(activationFilePaths(cwd, statement, join(parentAlias, 'plan'))).rejects.toThrow(
      'plan must remain outside',
    );
  });

  it('rejects permissive statements and cannot locate a workspace outside the repository', async () => {
    const { cwd, statement, output } = await fixture();
    await chmod(statement, 0o644);
    await expect(activationFilePaths(cwd, statement, output)).rejects.toThrow('mode-0600');
    await expect(activationFilePaths(tmpdir(), statement, output)).rejects.toThrow(
      'workspace root',
    );
  });

  it('rejects existing outputs and dangling symlinks without changing their targets', async () => {
    const { cwd, statement, output } = await fixture();
    await writeFile(output, 'existing');
    await expect(activationFilePaths(cwd, statement, output)).rejects.toThrow('new file');
    await expect(writeActivationPlan(output, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(output, 'utf8')).toBe('existing');
    await rm(output);
    const absent = `${output}-absent`;
    await symlink(absent, output);
    await expect(activationFilePaths(cwd, statement, output)).rejects.toThrow('new file');
    await expect(writeActivationPlan(output, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an output symlink created after validation', async () => {
    const { cwd, statement, output } = await fixture();
    const paths = await activationFilePaths(cwd, statement, output);
    await symlink(statement, output);
    await expect(writeActivationPlan(paths.output, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(statement, 'utf8')).toBe('synthetic fixture');
  });
});
