const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

/** Run only the selected suite in a newly owned, disposable MySQL server. */
async function runDisposableMigration(domain) {
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
  const name = `nestjs-${domain}-migration-${runId}`;
  const label = `nestjs.${domain}-migration-run`;
  const database = `nestjs_${domain}_migration_test`;
  const user = `${domain}_migration_test`;
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

  const onInterrupt = (signal) => {
    interrupted = true;
    child?.kill(signal);
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  async function main() {
    if (process.versions.node !== '26.13.0')
      throw new Error('Migration verification requires Node.js 26.13.0');
    if (!['article', 'comment', 'attachment'].includes(domain))
      throw new Error('Unknown disposable migration suite');
    const jestArguments = process.argv.slice(2);
    if (
      jestArguments.some(
        (argument) => !argument.startsWith('--cacheDirectory='),
      )
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
        container.Config.Hostname !== container.Id.slice(0, 12) ||
        Object.keys(container.HostConfig.Tmpfs ?? {}).length !== 1 ||
        container.HostConfig.Tmpfs['/var/lib/mysql'] !== 'rw' ||
        container.HostConfig.Binds?.length ||
        container.Mounts.some(
          (mount) =>
            mount.Type !== 'tmpfs' || mount.Destination !== '/var/lib/mysql',
        ) ||
        Object.values(container.NetworkSettings.Ports).filter(Boolean)
          .length !== 1 ||
        ports?.length !== 1 ||
        ports[0].HostIp !== '127.0.0.1' ||
        !Number.isInteger(Number(ports[0].HostPort)) ||
        Number(ports[0].HostPort) < 32768 ||
        Number(ports[0].HostPort) > 65535
      ) {
        throw new Error(
          `Unsafe disposable MySQL container configuration: ${JSON.stringify({
            running: container.State.Running,
            image: container.Config.Image,
            hostname: container.Config.Hostname,
            expectedHostname: container.Id.slice(0, 12),
            tmpfs: container.HostConfig.Tmpfs,
            mounts: container.Mounts.map(({ Type, Destination }) => ({
              Type,
              Destination,
            })),
            ports,
          })}`,
        );
      }
      // Docker may omit --tmpfs from Mounts. Verify the actual kernel mount too,
      // as the unprivileged image user, rather than trusting that empty list.
      const mounts = dockerRun([
        'exec',
        '--user',
        'mysql',
        container.Id,
        'cat',
        '/proc/mounts',
      ]);
      if (
        !mounts.split('\n').some((line) => {
          const [, destination, type] = line.split(' ');
          return destination === '/var/lib/mysql' && type === 'tmpfs';
        })
      )
        throw new Error('MySQL data directory is not backed by tmpfs');
      const port = Number(ports[0].HostPort);
      let serverUuid;
      let identity;
      let grants;
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
          const [[readyIdentity]] = await connection.query(
            'SELECT @@server_uuid AS serverUuid, @@hostname AS hostname, DATABASE() AS db, CURRENT_USER() AS account',
          );
          const [grantRows] = await connection.query(
            'SHOW GRANTS FOR CURRENT_USER',
          );
          grants = grantRows.map((row) =>
            Object.values(row)[0].replaceAll('\\', ''),
          );
          identity = readyIdentity;
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
      if (
        identity.hostname !== container.Config.Hostname ||
        identity.db !== database ||
        identity.account !== `${user}@%`
      )
        throw new Error('Disposable MySQL target identity mismatch');
      const expectedGrants = [
        `GRANT USAGE ON *.* TO \`${user}\`@\`%\``,
        `GRANT ALL PRIVILEGES ON \`${database}\`.* TO \`${user}\`@\`%\``,
      ];
      if (
        grants.length !== expectedGrants.length ||
        grants.some((grant) => !expectedGrants.includes(grant))
      )
        throw new Error(
          'Disposable MySQL account is not restricted to its test schema',
        );
      console.log(
        `Disposable ${domain} migration target: ${name} (${containerId.slice(0, 12)}), 127.0.0.1:${port}/${database}; kernel tmpfs verified; schema-scoped user=${user}; server_uuid=${serverUuid}; hostname=${identity.hostname}`,
      );
      const exitCode = await new Promise((resolve, reject) => {
        child = spawn(
          process.execPath,
          [
            '--experimental-vm-modules',
            path.join(project, 'node_modules/jest/bin/jest.js'),
            '--config',
            `test/jest-${domain}-migration.json`,
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
              [`${domain.toUpperCase()}_MIGRATION_DISPOSABLE`]: runId,
              [`${domain.toUpperCase()}_MIGRATION_DB_PORT`]: String(port),
              [`${domain.toUpperCase()}_MIGRATION_DB_PASSWORD`]: password,
              [`${domain.toUpperCase()}_MIGRATION_SERVER_UUID`]: serverUuid,
              [`${domain.toUpperCase()}_MIGRATION_CONTAINER_ID`]: containerId,
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
        console.log(`Removed disposable ${domain} migration container ${name}`);
      }
    }
  }

  try {
    await main();
  } catch (error) {
    // Never dump process env or Docker inspect results containing credentials.
    console.error(`Migration verification failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

module.exports = { runDisposableMigration };
