import { spawnSync } from 'node:child_process';

const IMAGE = 'hda-vault-smoke';
const CONTAINER = 'hda-vault-smoke-test';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function hasDocker() {
  const result = spawnSync('docker', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

try {
  if (!hasDocker()) {
    console.warn('[docker-smoke] Docker is not installed in this environment. Skipping local smoke test.');
    process.exit(0);
  }
  run('docker', ['build', '-t', IMAGE, '.']);
  run('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  run('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', '18080:8080', IMAGE]);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  run('node', ['-e', "fetch('http://127.0.0.1:18080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);
} finally {
  spawnSync('docker', ['rm', '-f', CONTAINER], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
}
