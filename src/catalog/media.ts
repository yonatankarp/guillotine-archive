import { Readable } from 'node:stream';
import { htmlToText } from 'html-to-text';
import mammoth from 'mammoth';
import sharp from 'sharp';
import yauzl from 'yauzl';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SIZE_LIMIT_ERROR = `Text exceeds maximum size of ${MAX_TEXT_BYTES} bytes`;

function hasExtension(name: string, ...extensions: string[]): boolean {
  const lowerName = name.toLowerCase();
  return extensions.some((extension) => lowerName.endsWith(extension));
}

function textSizeLimitError(): Error {
  return new Error(SIZE_LIMIT_ERROR);
}

function assertTextSize(value: string | Buffer): void {
  const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
  if (size > MAX_TEXT_BYTES) {
    throw textSizeLimitError();
  }
}

function getHtmlCharset(data: Buffer): string | undefined {
  const header = data.subarray(0, 2048).toString('latin1');
  const metaTags = header.match(/<meta\b[^>]*>/gi) ?? [];

  for (const metaTag of metaTags) {
    const directCharset = getHtmlAttribute(metaTag, 'charset');
    if (directCharset) {
      return supportedCharset(directCharset);
    }

    const httpEquiv = getHtmlAttribute(metaTag, 'http-equiv');
    if (httpEquiv?.toLowerCase() !== 'content-type') {
      continue;
    }

    const content = getHtmlAttribute(metaTag, 'content');
    const contentCharset = /(?:^|;)\s*charset\s*=\s*([^\s"'>/;]+)/i.exec(content ?? '')?.[1];
    if (contentCharset) {
      return supportedCharset(contentCharset);
    }
  }

  return undefined;
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const expression = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = expression.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function supportedCharset(value: string): string | undefined {
  const charset = value.toLowerCase();
  return charset === 'windows-1255' || charset === 'iso-8859-8' ? charset : undefined;
}

/**
 * The archive is late-1990s Israeli material, so a file that is not valid UTF-8
 * is almost certainly Windows-1255 rather than genuinely broken. Decoding it as
 * UTF-8 anyway turns every Hebrew byte into U+FFFD, which is silent and total
 * data loss: the whole corpus reduced to its ASCII digits.
 *
 * A declared HTML charset still wins, and the sniff window stays bounded, so a
 * declaration outside it is handled by the same fallback as no declaration.
 */
const LEGACY_HEBREW_ENCODING = 'windows-1255';

function decodeExactly(data: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function decodeText(data: Buffer, isHtmlInput: boolean): string {
  const charset = isHtmlInput ? getHtmlCharset(data) : undefined;
  if (charset === 'windows-1255' || charset === 'iso-8859-8') {
    return new TextDecoder(charset).decode(data);
  }

  return (
    decodeExactly(data, 'utf-8') ??
    decodeExactly(data, LEGACY_HEBREW_ENCODING) ??
    new TextDecoder('utf-8').decode(data)
  );
}

function isHtml(mimeType: string, name: string): boolean {
  const normalizedMimeType = mimeType.toLowerCase().split(';', 1)[0]?.trim();
  return (
    normalizedMimeType === 'text/html' ||
    normalizedMimeType === 'application/xhtml+xml' ||
    hasExtension(name, '.html', '.htm')
  );
}

function isDocx(mimeType: string, name: string): boolean {
  return (
    mimeType.toLowerCase().split(';', 1)[0]?.trim() === DOCX_MIME_TYPE ||
    hasExtension(name, '.docx')
  );
}

function preflightDocx(data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Unable to read DOCX archive'));
        return;
      }

      let totalUncompressedSize = 0;
      let settled = false;
      let activeStream: Readable | undefined;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          activeStream?.destroy();
          zip.close();
        } catch (cleanupError) {
          reject(cleanupError);
          return;
        }
        callback();
      };
      const fail = (failure: unknown) => finish(() => reject(failure));
      const readNextEntry = () => {
        try {
          zip.readEntry();
        } catch (readError) {
          fail(readError);
        }
      };

      zip.on('entry', (entry) => {
        if (settled) {
          return;
        }

        if (entry.fileName.endsWith('/')) {
          readNextEntry();
          return;
        }

        try {
          zip.openReadStream(entry, (streamError, stream) => {
            if (settled) {
              stream?.destroy();
              return;
            }

            if (streamError || !stream) {
              fail(streamError ?? new Error('Unable to read DOCX entry'));
              return;
            }

            activeStream = stream;
            stream.on('data', (chunk: Buffer) => {
              totalUncompressedSize += chunk.length;
              if (totalUncompressedSize > MAX_TEXT_BYTES) {
                fail(textSizeLimitError());
              }
            });
            stream.on('end', () => {
              if (!settled) {
                activeStream = undefined;
                readNextEntry();
              }
            });
            stream.on('error', fail);
          });
        } catch (streamOpenError) {
          fail(streamOpenError);
        }
      });
      zip.on('end', () => finish(resolve));
      zip.on('error', fail);
      readNextEntry();
    });
  });
}

function trimExtractedText(text: string): string {
  assertTextSize(text);
  return text.trim();
}

export function isTextExtractable(
  mimeType: string,
  name: string,
  size: number | null,
): boolean {
  if (size !== null && size > MAX_TEXT_BYTES) {
    return false;
  }

  return (
    mimeType.toLowerCase().startsWith('text/') ||
    hasExtension(name, '.txt', '.html', '.htm') ||
    isDocx(mimeType, name)
  );
}

export async function extractText(mimeType: string, name: string, data: Buffer): Promise<string> {
  assertTextSize(data);

  if (isDocx(mimeType, name)) {
    await preflightDocx(data);
    const result = await mammoth.extractRawText({ buffer: data });
    return trimExtractedText(result.value);
  }

  const htmlInput = isHtml(mimeType, name);
  const text = decodeText(data, htmlInput);
  if (htmlInput) {
    const extracted = htmlToText(text, {
      wordwrap: false,
      selectors: [{ selector: 'img', format: 'skip' }],
    });
    return trimExtractedText(extracted);
  }

  return trimExtractedText(text);
}

export async function optimizeCover(data: Buffer): Promise<Buffer> {
  return sharp(data)
    .rotate()
    .resize(720, 960, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}
