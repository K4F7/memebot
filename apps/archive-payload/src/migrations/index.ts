import * as migration_20260809_190501 from './20260809_190501';
import * as migration_20260810_220500_media_storage_key from './20260810_220500_media_storage_key';
import * as migration_20260811_010000_work_authoring from './20260811_010000_work_authoring';

export const migrations = [
  {
    up: migration_20260809_190501.up,
    down: migration_20260809_190501.down,
    name: '20260809_190501',
  },
  {
    up: migration_20260810_220500_media_storage_key.up,
    down: migration_20260810_220500_media_storage_key.down,
    name: '20260810_220500_media_storage_key',
  },
  {
    up: migration_20260811_010000_work_authoring.up,
    down: migration_20260811_010000_work_authoring.down,
    name: '20260811_010000_work_authoring'
  },
];
