import MiniSearch from 'minisearch';
import {
  createSearchEngine,
  extractHebrewTokens,
  getSearchOptions,
  isReleaseType,
  type ArchiveSearchResult,
  type SearchDocument,
} from '../catalog/search';
import { deriveKind } from '../catalog/kind';
import { releaseTypeLabel } from '../components/release-view';
import { externalHttpUrl, sitePathForBrowserBase } from '../lib/browser-url';

const EMPTY_STATUS = 'נו? כתבו משהו בעברית. אנחנו לא הולכים לנחש בשבילכם.';
const FAILURE_STATUS = 'לא הצלחנו לטעון את החיפוש. משהו נפל ואנחנו לא בטוחים מה. קיבינימאט.';
const LOADING_STATUS = 'רגע! טוענים את המפתח של הארכיון…';
const RESULT_LIMIT = 100;

interface SearchElements {
  root: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  category: HTMLSelectElement;
  kind: HTMLSelectElement;
  submit: HTMLButtonElement;
  status: HTMLElement;
  fallback: HTMLElement;
  list: HTMLOListElement;
  baseUrl: string;
  indexUrl: string;
}

interface StoredCollectionLink {
  slug: string;
  titleHe: string;
  relationship: 'part-of-release' | 'about' | 'inspired-by';
  groupHe?: string;
}

interface CommonStoredResult extends Record<string, unknown> {
  id: string;
  score: number;
  kind: unknown;
  titleHe: string;
  href: string;
  category: string;
  categories: string[];
  filename: string;
  path: string;
  mimeType: string;
  size: number | null;
  collectionLinks: StoredCollectionLink[];
  viewUrl: unknown;
  downloadUrl: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCollectionLink(value: unknown): value is StoredCollectionLink {
  if (!isRecord(value)) return false;
  return (
    typeof value.slug === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug) &&
    typeof value.titleHe === 'string' &&
    ['part-of-release', 'about', 'inspired-by'].includes(String(value.relationship)) &&
    (value.groupHe === undefined || typeof value.groupHe === 'string')
  );
}

function hasCommonSearchMetadata(
  value: Record<string, unknown>,
): value is CommonStoredResult {
  return (
    typeof value.id === 'string' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    typeof value.titleHe === 'string' &&
    typeof value.href === 'string' &&
    typeof value.category === 'string' &&
    isStringArray(value.categories) &&
    typeof value.filename === 'string' &&
    typeof value.path === 'string' &&
    typeof value.mimeType === 'string' &&
    (value.size === null ||
      (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0)) &&
    Array.isArray(value.collectionLinks) &&
    value.collectionLinks.every(isCollectionLink)
  );
}

function isSearchResult(value: unknown, baseUrl: string): value is ArchiveSearchResult {
  if (!isRecord(value)) return false;
  if (!hasCommonSearchMetadata(value)) return false;

  if (value.kind === 'collection') {
    return (
      value.id.startsWith('collection:') &&
      (value.collectionType === undefined || isReleaseType(value.collectionType)) &&
      value.titleHe.trim().length > 0 &&
      value.href.trim().length > 0 &&
      sitePathForBrowserBase(baseUrl, value.href) !== null &&
      value.filename === '' &&
      value.path === '' &&
      value.mimeType === '' &&
      value.size === null &&
      value.collectionLinks.length === 0 &&
      value.viewUrl === null &&
      value.downloadUrl === null
    );
  }

  if (value.kind !== 'file') return false;
  const viewUrl = externalHttpUrl(value.viewUrl);
  const downloadUrl =
    value.downloadUrl === null ? null : externalHttpUrl(value.downloadUrl);
  return (
    value.id.startsWith('file:') &&
    value.filename.trim().length > 0 &&
    value.path.trim().length > 0 &&
    value.mimeType.trim().length > 0 &&
    value.category.trim().length > 0 &&
    value.categories.includes(value.category) &&
    viewUrl !== null &&
    externalHttpUrl(value.href) === viewUrl &&
    (value.downloadUrl === null || downloadUrl !== null)
  );
}

function appendText<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function appendExternalAction(
  parent: HTMLElement,
  href: string,
  visibleLabel: string,
  accessibleLabel: string,
  className: string,
): void {
  const link = document.createElement('a');
  link.className = `result-action ${className}`;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.ariaLabel = accessibleLabel;
  link.textContent = visibleLabel;
  parent.append(link);
}

function formatSize(size: number | null): string {
  if (size === null) return 'גודל לא ידוע';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A collection card opens a release room, so it names the release. 'משחק שלם' rather than the
 * plainer 'משחק' because it is the counterweight to 'קובץ בודד' on a file card. An index built
 * before collectionType was stored holds games only, so an absent type reads as one.
 */
function collectionKindLabel(type: ArchiveSearchResult['collectionType']): string {
  return type === undefined || type === 'game' ? 'משחק שלם' : releaseTypeLabel(type);
}

function renderCollection(result: ArchiveSearchResult, baseUrl: string): HTMLLIElement {
  const href = sitePathForBrowserBase(baseUrl, result.href);
  if (!href || !result.titleHe.trim()) throw new Error('invalid collection result');

  const item = document.createElement('li');
  appendText(item, 'span', collectionKindLabel(result.collectionType), 'result-kind');
  const heading = appendText(item, 'p', '', 'result-heading');
  const link = document.createElement('a');
  link.className = 'collection-result-link';
  link.href = href;
  link.ariaLabel = `פתיחת אוסף — ${result.titleHe}`;
  link.textContent = result.titleHe;
  heading.append(link);

  if (result.categories.length > 0) {
    appendText(item, 'p', result.categories.join(' · '), 'result-meta');
  }
  return item;
}

function renderFile(result: ArchiveSearchResult, baseUrl: string): HTMLLIElement {
  if (!result.filename.trim() || !result.category.trim() || !result.path.trim()) {
    throw new Error('invalid file result');
  }
  const viewUrl = result.viewUrl === null ? null : externalHttpUrl(result.viewUrl);
  const downloadUrl = result.downloadUrl === null ? null : externalHttpUrl(result.downloadUrl);
  if ((result.viewUrl !== null && !viewUrl) || (result.downloadUrl !== null && !downloadUrl)) {
    throw new Error('invalid file URL');
  }

  const item = document.createElement('li');
  appendText(item, 'span', 'קובץ בודד', 'result-kind');
  const heading = appendText(item, 'p', '', 'result-heading');
  const filename = document.createElement('bdi');
  filename.dir = 'auto';
  filename.textContent = result.filename;
  const strong = document.createElement('strong');
  strong.append(filename);
  heading.append(strong);

  const meta = appendText(item, 'p', '', 'result-meta');
  for (const value of [result.category, result.mimeType, formatSize(result.size)]) {
    appendText(meta, 'span', value);
  }
  const path = appendText(item, 'p', '', 'result-path');
  const pathText = document.createElement('bdi');
  pathText.dir = 'auto';
  pathText.textContent = result.path;
  path.append(pathText);

  for (const relationship of result.collectionLinks) {
    if (relationship.relationship !== 'part-of-release') continue;
    const relationshipHref = sitePathForBrowserBase(
      baseUrl,
      `/release/${relationship.slug}/`,
    );
    if (!relationshipHref) throw new Error('invalid relationship URL');
    const relationshipLine = appendText(item, 'p', '', 'result-meta');
    const relationshipLink = document.createElement('a');
    relationshipLink.href = relationshipHref;
    relationshipLink.textContent = `שייך למהדורה הרשמית: ${relationship.titleHe}`;
    relationshipLine.append(relationshipLink);
  }

  if (viewUrl || downloadUrl) {
    const actions = appendText(item, 'div', '', 'result-actions');
    if (viewUrl) {
      appendExternalAction(
        actions,
        viewUrl,
        'צפייה',
        `צפייה — ${result.filename}`,
        'result-action-view',
      );
    }
    if (downloadUrl) {
      appendExternalAction(
        actions,
        downloadUrl,
        'הורדה',
        `הורדה — ${result.filename}`,
        'result-action-download',
      );
    }
  }
  return item;
}

function renderResult(result: ArchiveSearchResult, baseUrl: string): HTMLLIElement {
  return result.kind === 'collection'
    ? renderCollection(result, baseUrl)
    : renderFile(result, baseUrl);
}

function resultStatus(total: number): string {
  if (total === 0) return 'לא מצאנו כלום! חיפשנו, קיבינימאט, באמת חיפשנו.';
  if (total === 1) return 'תוצאה אחת';
  if (total > RESULT_LIMIT) {
    return `${total} תוצאות. מוצגות רק ${RESULT_LIMIT} התוצאות הראשונות.`;
  }
  return `${total} תוצאות`;
}

/**
 * The committed search index does not store an item's kind, and it is a build artifact this
 * page cannot regenerate. Every input deriveKind needs is stored, though, so the filter runs
 * the same derivation the catalog used rather than duplicating its rules.
 */
function filterByKind(
  results: readonly ArchiveSearchResult[],
  kind: string,
): readonly ArchiveSearchResult[] {
  if (!kind) return results;

  return results.filter(
    (result) =>
      result.kind === 'file' &&
      deriveKind({
        mimeType: result.mimeType,
        path: result.path,
        size: result.size,
        name: result.filename,
      }) === kind,
  );
}

function getElements(root: HTMLElement): SearchElements | null {
  const form = root.querySelector<HTMLFormElement>('[data-search-form]');
  const input = root.querySelector<HTMLInputElement>('[data-search-input]');
  const category = root.querySelector<HTMLSelectElement>('[data-search-category]');
  const kind = root.querySelector<HTMLSelectElement>('[data-search-kind]');
  const status = root.querySelector<HTMLElement>('[data-search-status]');
  const fallback = root.querySelector<HTMLElement>('[data-search-fallback]');
  const list = root.querySelector<HTMLOListElement>('[data-search-results]');
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const { baseUrl, indexUrl } = root.dataset;
  if (
    !form ||
    !input ||
    !category ||
    !kind ||
    !submit ||
    !status ||
    !fallback ||
    !list ||
    !baseUrl ||
    !indexUrl
  ) {
    return null;
  }
  return {
    root,
    form,
    input,
    category,
    kind,
    submit,
    status,
    fallback,
    list,
    baseUrl,
    indexUrl,
  };
}

function initializeQuery(elements: SearchElements): void {
  const params = new URLSearchParams(location.search);
  elements.input.value = params.get('q') ?? '';
  const requestedCategory = params.get('category') ?? '';
  elements.category.value = Array.from(elements.category.options).some(
    (option) => option.value === requestedCategory,
  )
    ? requestedCategory
    : '';
  const requestedKind = params.get('kind') ?? '';
  elements.kind.value = Array.from(elements.kind.options).some(
    (option) => option.value === requestedKind,
  )
    ? requestedKind
    : '';
}

function updateLocation(elements: SearchElements): void {
  const url = new URL(location.href);
  const query = elements.input.value.trim();
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  if (elements.category.value) url.searchParams.set('category', elements.category.value);
  else url.searchParams.delete('category');
  if (elements.kind.value) url.searchParams.set('kind', elements.kind.value);
  else url.searchParams.delete('kind');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function showFailure(elements: SearchElements): void {
  elements.list.replaceChildren();
  elements.status.textContent = FAILURE_STATUS;
  elements.fallback.hidden = false;
  elements.root.ariaBusy = 'false';
}

type SearchControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

function loadingControls(elements: SearchElements): SearchControl[] {
  return [elements.input, elements.category, elements.kind, elements.submit];
}

/**
 * Locking the controls while the index downloads is deliberate, but disabling the one a user
 * is standing in drops focus to <body> and ejects them to the top of the document mid-load
 * with nothing said about why. So focus parks on the status line, which is already announcing
 * the load, and beginLoading reports whether it landed there.
 */
function beginLoading(elements: SearchElements): boolean {
  const controls = loadingControls(elements);
  const heldFocus = controls.some((control) => control === document.activeElement);

  elements.root.ariaBusy = 'true';
  elements.status.textContent = LOADING_STATUS;
  for (const control of controls) control.disabled = true;
  if (!heldFocus) return false;

  elements.status.focus();

  return document.activeElement === elements.status;
}

function endLoading(elements: SearchElements, parkedFocus: boolean): void {
  elements.root.ariaBusy = 'false';
  for (const control of loadingControls(elements)) control.disabled = false;
  /* Take focus back only from the status line we put it on. A user who tabbed away during the
     load stays where they went. */
  if (parkedFocus && document.activeElement === elements.status) elements.input.focus();
}

async function start(root: HTMLElement): Promise<void> {
  if (root.dataset.searchInitialized === 'true') return;
  root.dataset.searchInitialized = 'true';
  const elements = getElements(root);
  if (!elements) return;

  initializeQuery(elements);
  const parkedFocus = beginLoading(elements);
  try {
    const response = await fetch(elements.indexUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('search index request failed');
    const serialized = await response.text();
    const engine = createSearchEngine(
      MiniSearch.loadJSON<SearchDocument>(serialized, getSearchOptions()),
    );

    const run = (updateUrl: boolean): void => {
      try {
        elements.list.replaceChildren();
        elements.fallback.hidden = true;
        const query = elements.input.value.trim();
        if (updateUrl) updateLocation(elements);
        if (!query) {
          elements.status.textContent = EMPTY_STATUS;
          return;
        }
        if (extractHebrewTokens(query).length === 0) {
          elements.status.textContent = 'החיפוש פה עובד בעברית בלבד. סליחה, ככה בנינו אותו.';
          return;
        }

        const matches = engine.search(query, {
          category: elements.category.value || undefined,
        });
        if (!matches.every((match) => isSearchResult(match, elements.baseUrl))) {
          throw new Error('invalid stored search metadata');
        }
        const selected = filterByKind(matches, elements.kind.value);
        const rendered = selected.slice(0, RESULT_LIMIT).map((result) =>
          renderResult(result, elements.baseUrl),
        );
        elements.list.append(...rendered);
        elements.status.textContent = resultStatus(selected.length);
      } catch {
        showFailure(elements);
      }
    };

    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(true);
    });
    elements.category.addEventListener('change', () => run(true));
    elements.kind.addEventListener('change', () => run(true));
    endLoading(elements, parkedFocus);
    run(false);
  } catch {
    endLoading(elements, parkedFocus);
    showFailure(elements);
  }
}

if (typeof document !== 'undefined') {
  const root = document.querySelector<HTMLElement>('[data-search-root]');
  if (root) void start(root);
}
