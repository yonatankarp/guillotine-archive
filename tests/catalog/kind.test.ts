import { describe, expect, test } from 'vitest';
import { deriveKind } from '../../src/catalog/kind';
import type { DriveFile } from '../../src/catalog/types';

function driveFile(overrides: Partial<DriveFile> & Pick<DriveFile, 'path'>): DriveFile {
  const name = overrides.name ?? overrides.path.split('/').at(-1) ?? '';

  return {
    id: 'drive-id',
    mimeType: 'application/octet-stream',
    size: 1024,
    modifiedTime: null,
    viewUrl: 'https://drive.google.com/file/d/drive-id/view',
    downloadUrl: null,
    ...overrides,
    name,
  };
}

describe('deriveKind', () => {
  test('classifies every video mime as video regardless of path', () => {
    for (const mimeType of ['video/mp4', 'video/x-ms-wmv', 'video/x-msvideo', 'video/mpeg']) {
      expect(deriveKind(driveFile({ path: 'סרטונים/טלוויזיה/clip', mimeType }))).toBe('video');
    }
  });

  describe('audio', () => {
    test('treats audio under the songs category as released tracks', () => {
      expect(
        deriveKind(
          driveFile({ path: 'שירים/פיפוש 2 שירים/שיר פתיחה.AIF', mimeType: 'audio/aiff' }),
        ),
      ).toBe('track');
    });

    test('treats audio inside a full-disc or audio-disc path as a track', () => {
      for (const path of [
        'פרטי אספנות/דיסקים מלאים/דיסק/01.aif',
        'משחקים מלאים/פיפוש 1 - דיסק אודיו/01.aif',
      ]) {
        expect(deriveKind(driveFile({ path, mimeType: 'audio/x-aiff' }))).toBe('track');
      }
    });

    test('treats a numbered Track filename as a track', () => {
      expect(
        deriveKind(driveFile({ path: 'פרטי אספנות/דיסק/01 Track 1.wav', mimeType: 'audio/wav' })),
      ).toBe('track');
    });

    test('treats compressed audio as a track and uncompressed game audio as a sound', () => {
      expect(
        deriveKind(driveFile({ path: 'דמואים/פיפוש1/x.mp3', mimeType: 'audio/mp3' })),
      ).toBe('track');
      expect(
        deriveKind(driveFile({ path: 'דמואים/פיפוש1/x.wma', mimeType: 'audio/x-ms-wma' })),
      ).toBe('track');
      expect(
        deriveKind(driveFile({ path: 'דמואים/פיפוש1 - אנגלית/FX/KEY.AIF', mimeType: 'audio/x-aiff' })),
      ).toBe('sound');
      expect(
        deriveKind(driveFile({ path: 'דמואים/פיפוש1/SND/door.wav', mimeType: 'audio/wav' })),
      ).toBe('sound');
    });
  });

  describe('images', () => {
    test('resolves editorial image roles from the path before any mime heuristic', () => {
      expect(
        deriveKind(
          driveFile({
            path: 'משחקים מלאים/פיפוש 1/פיפוש 1 - חוברת משחק/01.gif',
            mimeType: 'image/gif',
            size: 400,
          }),
        ),
      ).toBe('booklet-page');
      expect(
        deriveKind(driveFile({ path: 'עיתונות/כתבות/1998/a.jpg', mimeType: 'image/jpeg' })),
      ).toBe('press-page');
      expect(
        deriveKind(driveFile({ path: 'עיתונות/קומיקס/1.jpg', mimeType: 'image/jpeg' })),
      ).toBe('comic-page');
      for (const path of [
        'משחקים מלאים/פיפוש 2/פיפוש 2 - עטיפה/front.jpg',
        'משחקים מלאים/חלום שהתגשם/אריזה/box.jpg',
      ]) {
        expect(deriveKind(driveFile({ path, mimeType: 'image/jpeg' }))).toBe('cover');
      }
    });

    test('classifies indexed and palette image formats as sprites at any size', () => {
      for (const mimeType of ['image/pcx', 'image/x-icon', 'image/gif', 'image/x-raw']) {
        expect(
          deriveKind(driveFile({ path: 'דמואים/פיפוש1/ART/a', mimeType, size: 5_000_000 })),
        ).toBe('sprite');
      }
    });

    test('splits bitmaps on size but never demotes a photographic format', () => {
      expect(
        deriveKind(
          driveFile({ path: 'פרטי אספנות/דיסק/Data/Font.bmp', mimeType: 'image/bmp', size: 41_526 }),
        ),
      ).toBe('sprite');
      expect(
        deriveKind(
          driveFile({ path: 'פרטי אספנות/דיסק/logo.bmp', mimeType: 'image/bmp', size: 921_656 }),
        ),
      ).toBe('scan');
      // A small JPEG is still a photograph: 1999-era sprites were never lossy.
      expect(
        deriveKind(
          driveFile({ path: 'פרטי אספנות/דיסק/Jokes/1.jpg', mimeType: 'image/jpeg', size: 12_000 }),
        ),
      ).toBe('scan');
    });
  });

  test('classifies runnable and archived payloads as builds', () => {
    for (const mimeType of [
      'application/x-msdownload',
      'application/x-dosexec',
      'application/x-msdos-program',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-rar',
      'application/x-iso9660-image',
      'application/x-cab',
      'application/x-123',
    ]) {
      expect(deriveKind(driveFile({ path: 'משחקים מלאים/פיפוש 1/game', mimeType }))).toBe('build');
    }
  });

  test('classifies text and word-processor formats as documents', () => {
    for (const mimeType of [
      'text/plain',
      'text/html',
      'text/css',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
    ]) {
      expect(deriveKind(driveFile({ path: 'פתרונות/פתרון', mimeType, size: null }))).toBe(
        'document',
      );
    }
  });

  describe('leftover binaries', () => {
    test('classifies engine payloads as game data, including mime-sniffed Director casts', () => {
      for (const name of [
        'gibbit.mdl',
        'actors.wdl',
        'resdoom.wmb',
        'acknex.mdf',
        'acknex.wdf',
        'Ter2.HMP',
        'resup0.SAV',
        'BRIJIT.CXT',
        'MASTER.CST',
        'layout.bin',
      ]) {
        expect(
          deriveKind(driveFile({ path: `דמואים/פיפוש1/${name}`, size: 200_000 })),
        ).toBe('game-data');
      }
      // A .DXR is Director content, not something a visitor can run.
      expect(
        deriveKind(
          driveFile({ path: 'דמואים/פיפוש1/DAY1.DXR', mimeType: 'application/x-director' }),
        ),
      ).toBe('game-data');
    });

    test('separates tiny configuration files from sizeable data of the same extension', () => {
      expect(deriveKind(driveFile({ path: 'דמואים/פיפוש1/lang.dat', size: 417 }))).toBe('noise');
      expect(deriveKind(driveFile({ path: 'דמואים/פיפוש1/big.dat', size: 40_000 }))).toBe(
        'game-data',
      );
      for (const name of ['AUTORUN.INF', 'SETUP.INI', 'game.cfg']) {
        expect(deriveKind(driveFile({ path: `דמואים/פיפוש1/${name}`, size: 64 }))).toBe('noise');
      }
    });

    test('classifies filesystem droppings as noise at any size', () => {
      expect(deriveKind(driveFile({ path: 'דמואים/Vegimon_Beta1.0/Thumbs.db', size: 5632 }))).toBe(
        'noise',
      );
      expect(deriveKind(driveFile({ path: 'פרטי אספנות/דיסק/Bot304.tmp', size: 0 }))).toBe('noise');
    });

    test('leaves genuinely unrecognised binaries as other rather than guessing', () => {
      expect(deriveKind(driveFile({ path: 'דמואים/פיפוש1/PIPMAC', size: 1_747_801 }))).toBe(
        'other',
      );
      expect(deriveKind(driveFile({ path: 'פרטי אספנות/דיסק/Busy.ani', size: 18_076 }))).toBe(
        'other',
      );
    });
  });

  test('tolerates a missing size without throwing', () => {
    expect(deriveKind(driveFile({ path: 'מה חסר?', mimeType: 'image/bmp', size: null }))).toBe(
      'scan',
    );
  });

  test('is case insensitive on both mime type and extension', () => {
    expect(deriveKind(driveFile({ path: 'a/b/c.ZIP', mimeType: 'APPLICATION/ZIP' }))).toBe('build');
    expect(deriveKind(driveFile({ path: 'a/b/GIBBIT.MDL', size: 200_000 }))).toBe('game-data');
  });
});
