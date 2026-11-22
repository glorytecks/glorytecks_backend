import { env } from './env';
import { logger } from './logger';

/**
 * Cloudinary stores and deletes uploads (services/upload.service.ts), which
 * only admin uploads use. Its SDK used to be loaded and configured at start-up,
 * so every cold start of the API paid for it whatever the request was. It is
 * now loaded on first use. The start-up log line, which says whether uploads
 * are configured, is unchanged.
 */
if (env.cloudinary.enabled) {
  logger.info('Cloudinary configured');
} else {
  logger.warn('Cloudinary not configured — file upload endpoints will return 503');
}

type CloudinarySdk = typeof import('cloudinary').v2;

let loading: Promise<CloudinarySdk> | undefined;

/**
 * The configured Cloudinary SDK. Callers check `env.cloudinary.enabled` first,
 * exactly as they did when the SDK was configured at start-up. A failed load
 * is not remembered, so the next upload tries again.
 */
export function getCloudinary(): Promise<CloudinarySdk> {
  loading ??= import('cloudinary').then(
    ({ default: sdk }) => {
      const cloudinary = sdk.v2;
      if (env.cloudinary.enabled) {
        cloudinary.config({
          cloud_name: env.cloudinary.cloudName,
          api_key: env.cloudinary.apiKey,
          api_secret: env.cloudinary.apiSecret,
          secure: true,
        });
      }
      return cloudinary;
    },
    (err: unknown) => {
      loading = undefined;
      throw err;
    },
  );
  return loading;
}
