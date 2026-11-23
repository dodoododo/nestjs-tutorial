const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const project = path.resolve(__dirname, '../..');
const windowsDocker = path.join(
  process.env.ProgramFiles || 'C:\\Program Files',
  'Docker/Docker/resources/bin/docker.exe',
);
const docker =
  process.env.DOCKER_BIN ||
  (process.platform === 'win32' && existsSync(windowsDocker)
    ? windowsDocker
    : 'docker');
const runId = randomBytes(16).toString('hex');
const name = `nestjs-article-migration-${runId}`;
const label = 'nestjs.article-migration-run';
const database = 'nestjs_article_migration_test';
const user = 'article_migration_test';
const password = randomBytes(32).toString('hex');
let containerId;
let child;
let interrupted = false;

function dockerRun(args, environment = process.env) {
  return execFileSync(docker, args, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    windowsHide: true,
  }).trim();
}

function ownedContainer() {
  const [container] = JSON.parse(dockerRun(['inspect', name]));
  if (
    container.Config.Labels[label] !== runId ||
    (containerId && container.Id !== containerId)
  ) {
    throw new Error(
      'Refusing to use or remove a container not owned by this run',
    );
  }
  return container;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
}

async function main() {
  if (process.versions.node !== '26.13.0')
    throw new Error('Article migration verification requires Node.js 26.13.0');
  const jestArguments = process.argv.slice(2);
  if (
    jestArguments.some((argument) => !argument.startsWith('--cacheDirectory='))
  )
    throw new Error(
      'Only --cacheDirectory=... is supported; the roundtrip must execute',
    );
  try {
    // No mounts/volumes and no shared server changes. Credentials travel by env
    // name, not command arguments. The test connects as the schema-scoped user.
    containerId = dockerRun(
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--label',
        `${label}=${runId}`,
        '--tmpfs',
        '/var/lib/mysql:rw',
        '--publish',
        '127.0.0.1::3306',
        '--env',
        'MYSQL_ROOT_PASSWORD',
        '--env',
        'MYSQL_DATABASE',
        '--env',
        'MYSQL_USER',
        '--env',
        'MYSQL_PASSWORD',
        'mysql:8.4',
      ],
      {
        ...process.env,
        MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex'),
        MYSQL_DATABASE: database,
        MYSQL_USER: user,
        MYSQL_PASSWORD: password,
      },
    );
    const container = ownedContainer();
    const ports = container.NetworkSettings.Ports['3306/tcp'];
    if (
      !container.State.Running ||
      container.Config.Image !== 'mysql:8.4' ||
      container.Mounts.some((mount) => mount.Type !== 'tmpfs') ||
      ports?.length !== 1 ||
      ports[0].HostIp !== '127.0.0.1' ||
      !Number.isInteger(Number(ports[0].HostPort)) ||
      Number(ports[0].HostPort) < 32768 ||
      Number(ports[0].HostPort) > 65535
    ) {
      throw new Error('Unsafe disposable MySQL container configuration');
    }
    const port = Number(ports[0].HostPort);
    let serverUuid;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !interrupted) {
      let connection;
      try {
        connection = await mysql.createConnection({
          host: '127.0.0.1',
          port,
          user,
          password,
          database,
          connectTimeout: 2_000,
        });
        const [[identity]] = await connection.query(
          'SELECT @@server_uuid AS serverUuid',
        );
        serverUuid = identity.serverUuid;
        break;
      } catch {
        // The image initializes accounts before starting its public listener.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } finally {
        await connection?.end();
      }
    }
    if (!serverUuid || interrupted)
      throw new Error('Disposable MySQL startup failed or was interrupted');
    console.log(
      `Disposable Article migration target: ${name} (${containerId.slice(0, 12)}), 127.0.0.1:${port}/${database}; tmpfs only; user=${user}; server_uuid=${serverUuid}`,
    );
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          '--experimental-vm-modules',
          path.join(project, 'node_modules/jest/bin/jest.js'),
          '--config',
          'test/jest-article-migration.json',
          '--runInBand',
          ...jestArguments,
        ],
        {
          cwd: project,
          stdio: 'inherit',
          windowsHide: true,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            ARTICLE_MIGRATION_DISPOSABLE: runId,
            ARTICLE_MIGRATION_DB_PORT: String(port),
            ARTICLE_MIGRATION_DB_PASSWORD: password,
            ARTICLE_MIGRATION_SERVER_UUID: serverUuid,
          },
        },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = interrupted ? 1 : exitCode;
  } finally {
    // Inspect by our unique name even if Docker created it but lost its reply.
    const existing = dockerRun([
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `name=^/${name}$`,
    ]);
    if (existing) {
      const container = ownedContainer();
      dockerRun(['rm', '--force', container.Id]);
      console.log(`Removed disposable Article migration container ${name}`);
    }
  }
}

main().catch((error) => {
  // Docker/MySQL errors can contain account data; do not dump process env/output.
  console.error(`Article migration verification failed: ${error.message}`);
  process.exitCode = 1;
});
