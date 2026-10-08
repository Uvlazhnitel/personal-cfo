import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function isWithin(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference === '' ||
    (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`))
  );
}

async function workspaceRoot(start: string): Promise<string> {
  let directory = await realpath(start);
  for (;;) {
    try {
      if ((await stat(join(directory, 'pnpm-workspace.yaml'))).isFile()) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the pnpm workspace root.');
    directory = parent;
  }
}

export async function activationFilePaths(
  cwd: string,
  statementPath: string,
  outputPath: string,
): Promise<Readonly<{ statement: string; output: string }>> {
  const repository = await workspaceRoot(cwd);
  const statement = await realpath(resolve(cwd, statementPath));
  const output = resolve(cwd, outputPath);
  const outputDirectory = await realpath(dirname(output));
  if (isWithin(repository, statement))
    throw new Error('The statement must remain outside the repository.');
  if (isWithin(repository, outputDirectory))
    throw new Error('The activation plan must remain outside the repository.');
  const metadata = await stat(statement);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error('The statement must be a mode-0600 file.');
  const protectedOutput = join(outputDirectory, basename(output));
  try {
    await lstat(protectedOutput);
    throw new Error(
      'The activation plan output must be a new file, not an existing file or symlink.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return Object.freeze({ statement, output: protectedOutput });
}

export async function writeActivationPlan(path: string, payload: string): Promise<void> {
  // O_EXCL rejects existing files and symlinks even if created after path validation.
  const file = await open(path, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${payload}\n`, 'utf8');
  } finally {
    await file.close();
  }
}
