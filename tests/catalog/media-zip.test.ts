import { deflateRawSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';

const extractRawText = vi.hoisted(() => vi.fn());

vi.mock('mammoth', () => ({
  default: { extractRawText },
}));

import { extractText } from '../../src/catalog/media';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

function craftedZipWithForgedUncompressedSize(): Buffer {
  const fileName = Buffer.from('word/document.xml');
  const compressed = deflateRawSync(Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
  const claimedSize = 1;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(claimedSize, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt16LE(20, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt16LE(8, 10);
  centralDirectory.writeUInt32LE(compressed.length, 20);
  centralDirectory.writeUInt32LE(claimedSize, 24);
  centralDirectory.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length + fileName.length, 12);
  end.writeUInt32LE(localHeader.length + fileName.length + compressed.length, 16);

  return Buffer.concat([localHeader, fileName, compressed, centralDirectory, fileName, end]);
}

test('rejects a real DOCX ZIP with forged metadata after actual decompression and before Mammoth', async () => {
  extractRawText.mockReset();

  await expect(
    extractText(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'notes.docx',
      craftedZipWithForgedUncompressedSize(),
    ),
  ).rejects.toThrow('Text exceeds maximum size');
  expect(extractRawText).not.toHaveBeenCalled();
});
