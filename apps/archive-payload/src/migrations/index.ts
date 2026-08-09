import * as migration_20260809_164918_archive_work_media from './20260809_164918_archive_work_media';
import * as migration_20260809_172004_archive_work_media_unique from './20260809_172004_archive_work_media_unique';

export const migrations = [
  {
    up: migration_20260809_164918_archive_work_media.up,
    down: migration_20260809_164918_archive_work_media.down,
    name: '20260809_164918_archive_work_media',
  },
  {
    up: migration_20260809_172004_archive_work_media_unique.up,
    down: migration_20260809_172004_archive_work_media_unique.down,
    name: '20260809_172004_archive_work_media_unique'
  },
];
