import { disposableMigrationTarget } from './disposable-migration-target';

export function articleMigrationTarget(environment: NodeJS.ProcessEnv) {
  return disposableMigrationTarget('article', environment);
}
