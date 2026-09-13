const keepAlive = setInterval(() => undefined, 60_000);
let isShuttingDown = false;

function shutDown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(JSON.stringify({ event: 'worker.shutdown', signal }));
  clearInterval(keepAlive);
  process.exitCode = 0;
}

console.info(JSON.stringify({ event: 'worker.started' }));
process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
