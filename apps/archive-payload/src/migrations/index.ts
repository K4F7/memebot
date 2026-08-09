import * as migration_20260809_190501 from './20260809_190501';

export const migrations = [
  {
    up: migration_20260809_190501.up,
    down: migration_20260809_190501.down,
    name: '20260809_190501'
  },
];
