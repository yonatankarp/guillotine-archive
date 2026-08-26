import type { DriveGetOptions } from '../../src/catalog/google-drive';

const supportedOptions = {
  responseType: 'arraybuffer',
  maxContentLength: 32 * 1024 * 1024,
} satisfies DriveGetOptions;

const unsupportedOptions = {
  responseType: 'arraybuffer',
  // @ts-expect-error Gaxios 7 does not support the Axios-only maxBodyLength option.
  maxBodyLength: 32 * 1024 * 1024,
} satisfies DriveGetOptions;

void supportedOptions;
void unsupportedOptions;
