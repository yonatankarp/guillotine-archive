/**
 * Strings the archive actually contains, each with the catalog path it was read from. Nothing
 * here is written for the site: Piposh has no script, only 678 PIP*.AIF clips whose order the
 * Director casts record, so an invented line would be a fabrication. Every entry below was
 * verified against src/generated/catalog.json by exact substring match on the item path.
 */
export interface ArchiveQuote {
  textHe: string;
  sourcePath: string;
}

export const ARCHIVE_QUOTES: readonly ArchiveQuote[] = [
  {
    textHe: 'בבקשה תקראו אותי - משעמם להיות פה לבד',
    sourcePath: 'פרטי אספנות/דיסק הקונגרס/Windows/Icons/רגילים/עטיפות/בבקשה תקראו אותי-משעמם להיות פה לבד.txt',
  },
  {
    textHe: 'אין לי ראש לזה',
    sourcePath: 'פרטי אספנות/דיסק הקונגרס/Atraktivi/Stickers/אין לי ראש לזה.bmp',
  },
  {
    textHe: 'קרבות של חזי נגד כולם כמו בכל בוקר בפיפוש',
    sourcePath: 'פרטי אספנות/דיסק הקונגרס/Atraktivi/Games/אופיר אלמקיאס/קרבות של חזי נגד כולם כמו בכל בוקר בפיפוש.zip',
  },
  {
    textHe: 'לא בטוח שנעים להכיר פיפוש והחברה',
    sourcePath: 'פרטי אספנות/דיסק הקונגרס/Atraktivi/Comix&Articles/לא בטוח שנעים להכיר פיפוש והחברה.doc',
  },
];
