import { access, cp, mkdir, rm } from 'node:fs/promises';
import { URL } from 'node:url';

const appRoot = new URL('./', import.meta.url);
const staticSource = new URL('./.next/static/', appRoot);
const standaloneRoot = new URL('./.next/standalone/apps/web/', appRoot);
const standaloneStatic = new URL('./.next/static/', standaloneRoot);

await access(staticSource);
await access(standaloneRoot);
await mkdir(new URL('./.next/', standaloneRoot), { recursive: true });
await rm(standaloneStatic, { force: true, recursive: true });
await cp(staticSource, standaloneStatic, { recursive: true });

const publicSource = new URL('./public/', appRoot);
const standalonePublic = new URL('./public/', standaloneRoot);
let publicExists = true;

try {
  await access(publicSource);
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    publicExists = false;
  } else {
    throw error;
  }
}

if (publicExists) {
  await rm(standalonePublic, { force: true, recursive: true });
  await cp(publicSource, standalonePublic, { recursive: true });
}
