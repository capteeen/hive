/**
 * THE ONE IMPORT.
 * Swap `./hive` for `./pack` and the entire app re-skins: copy, palette, verbs,
 * shape language and the 3D scene. Nothing else changes.
 */
import { hive } from './hive';
// import { pack } from './pack';

export const theme = hive;
// export const theme = pack;

export type { Theme } from './types';
