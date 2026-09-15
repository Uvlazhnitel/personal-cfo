import { stdin, stdout } from 'node:process';

import { createDatabaseContext, createLocalUser, requireDatabaseUrl } from '@personal-cfo/data';

const login = process.argv.slice(2).find((argument) => argument !== '--');
if (login === undefined) throw new Error('Usage: pnpm admin:create-user -- <login>');
if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive TTY is required.');

async function readHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          stdout.write('\n');
          finish();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readHidden('Password: ');
const confirmation = await readHidden('Confirm password: ');
if (password !== confirmation) throw new Error('Passwords do not match.');
const context = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 2 });
try {
  const ownerId = await createLocalUser(context.db, { loginName: login, password });
  console.info(JSON.stringify({ event: 'admin.user-created', ownerId }));
} finally {
  await context.close();
}
