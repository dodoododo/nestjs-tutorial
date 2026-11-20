export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
// Busboy emits LIMIT_FILE_SIZE on equality. This sentinel byte makes the public
// 5 MiB maximum inclusive; image validation independently checks actual bytes.
export const AVATAR_MULTIPART_FILE_LIMIT = AVATAR_MAX_BYTES + 1;
export const AVATAR_MAX_INPUT_PIXELS = 16 * 1024 * 1024;
export const AVATAR_MAX_DIMENSION = 1024;
export const AVATAR_PUBLIC_PATH = '/public/avatars';
export const AVATAR_OWNER_TYPE = 'user';

export const AVATAR_FORMATS = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const;

export type AvatarFormat = keyof typeof AVATAR_FORMATS;
export type AvatarExtension =
  (typeof AVATAR_FORMATS)[AvatarFormat]['extension'];

export const AVATAR_FILE_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;
