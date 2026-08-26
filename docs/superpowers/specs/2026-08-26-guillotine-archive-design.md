# Guillotine Archive Website Design

Date: 2026-08-26
Status: Approved design awaiting written-spec review
Interface language: Hebrew (RTL)
Hosting target: GitHub Pages
Source of truth: Google Drive

## 1. Purpose

Build a public Hebrew website for browsing and searching the Guillotine game archive. The site should make the archive feel curated and interconnected rather than exposing the Google Drive folder tree directly. Every downloadable original remains in Google Drive, while the website provides discovery, context, collection pages, and direct Drive actions.

The local archive used for discovery contains roughly 1,427 files across games, music, videos, press, fan games, collectibles, demos, graphics, and solutions. It is source material for development, not the website repository. The website repository lives at `~/Projects/guillotine-archive`.

## 2. Goals

- Present the archive through curated game and category pages.
- Provide fast free-text search designed and tested for Hebrew queries.
- Link every file to Google Drive for viewing or download.
- Discover new or changed Drive files automatically once per day.
- Keep official materials for a release interlinked across their physical Drive folders.
- Preserve press and fan works as independent collections instead of attaching them indiscriminately to game pages.
- Use a modernized Piposh visual language and character voice without looking like a generic gaming site or an unchanged 1990s website.
- Run entirely on GitHub Pages after each static build.

## 3. Non-goals for the first release

- Hosting the 13 GB archive inside GitHub or GitHub Pages.
- User accounts, comments, ratings, uploads, or an administration dashboard.
- Hourly or real-time Drive updates.
- Guaranteed English- or Russian-language search.
- OCR of scans and images. OCR can be added later without changing the catalog model.
- Automatically inferring every historical relationship with artificial intelligence.

## 4. Information architecture

The public site has these primary areas:

1. **Home** — prominent search, cover-first game tiles, and entry points to major archive categories.
2. **Games** — all official Guillotine games, each opening a curated game page.
3. **Game page** — overview, cover, official editions, game files, manuals, packaging, music discs, patches, solutions, and other materials that belong to that release.
4. **Music** — albums and individual audio materials.
5. **Videos** — archive videos and footage.
6. **Press** — articles, reviews, interviews, and scans as an independent collection.
7. **Fan works** — fan games and related creations as an independent collection.
8. **Archive categories** — demos, graphics, collectibles, solutions, and other source categories.
9. **Search results** — collection matches first, followed by individual files.
10. **About the archive** — archive purpose, Guillotine context, preservation notes, and download guidance.

Pages use stable Latin URL slugs such as `/games/piposh-1/`, while all visible navigation and editorial copy remain Hebrew and RTL.

## 5. Collection and relationship model

The public catalog does not mirror the Drive hierarchy. A collection is an editorial entity that can gather files from multiple Drive folders.

For example, the Piposh 1 page may include:

- Hebrew, English, and Russian official editions;
- cover and packaging scans;
- game and song booklets;
- the official extra music disc;
- patches, solutions, and other official release materials.

It does not automatically include press coverage or fan creations. Those remain in their own collections and are discoverable through browse pages and search.

Relationships have explicit meanings:

- `part-of-release`: a strong relationship shown on the game page and on the item.
- `about`: searchable topical metadata, used for material such as press.
- `inspired-by`: searchable topical metadata, used for fan works.

Only `part-of-release` causes an item to appear as an attachment on a game page. The other relationships improve discovery without implying that the item was included in the official release.

## 6. Curator data

A small version-controlled curator file supplements automatic Drive discovery. It defines stable editorial decisions rather than duplicating every Drive file manually.

Each collection records:

- stable slug and Hebrew title;
- type, year, summary, and optional longer description;
- selected Drive file ID for its cover;
- Hebrew search aliases and tags;
- Drive folder IDs or path rules that include official materials;
- explicit exclusions and relationship types;
- optional ordering and display groups;
- related collections where an editorial cross-link is useful.

Drive file IDs are the stable identity. Paths and names remain metadata and can change without creating duplicate records. Folder- and path-based rules make most future files automatic; explicit per-file overrides handle exceptions.

## 7. Drive file model

The daily index stores only public metadata needed by the site:

- Drive file ID;
- filename;
- MIME type and extension;
- size and modification time;
- normalized archive path and parent IDs;
- Drive view and download links;
- archive category;
- collection IDs and relationship types;
- Hebrew title, description, aliases, and tags when curated;
- extracted Hebrew text for supported text-based formats;
- cover or preview metadata when explicitly selected.

The generated index contains no service-account credentials or private Drive API responses.

## 8. Daily synchronization and publishing

A GitHub Actions workflow runs once per day and can also be started manually.

1. Authenticate to Google Drive with a read-only service account stored in GitHub Secrets.
2. Recursively list the configured archive folder with pagination.
3. Normalize file metadata and rebuild stable paths.
4. Extract searchable text from supported text formats such as plain text, HTML, and DOCX. Binary games and scans are indexed by metadata only in the first release.
5. Apply curator include, exclude, and relationship rules.
6. Download only selected cover images, resize and optimize them for the website, and leave every original in Drive.
7. Generate the public archive index, Hebrew search index, collection data, and static pages.
8. Validate the result.
9. Build and deploy to GitHub Pages only when every blocking validation passes.

If synchronization or validation fails, the workflow fails without replacing the current working deployment.

## 9. Search behavior

The search interface, supported query language, curated metadata, and relevance tests are Hebrew.

Search indexes:

- Hebrew collection titles and summaries;
- Hebrew aliases, descriptions, categories, and tags;
- Hebrew portions of filenames and paths;
- extracted Hebrew text from supported documents;
- Hebrew metadata inherited through collection relationships.

English filenames remain visible exactly as stored in Drive, but English and Russian linguistic search are not supported requirements. An English-named file, including a foreign-language Piposh 1 edition, is discoverable through its Hebrew collection relationship and Hebrew tags. No automatic translation is required.

Hebrew query normalization includes niqqud removal, punctuation and quote normalization, whitespace normalization, and consistent handling of final letter forms. The first release supports exact terms, prefixes, and conservative typo tolerance; it does not attempt full Hebrew morphological stemming.

Relevance order is:

1. matching game or editorial collection;
2. Hebrew curated title or alias;
3. Hebrew filename or path;
4. Hebrew tag or description;
5. extracted Hebrew document text.

Results show collections first and individual files second. Each file result includes its archive path, type, size when available, official collection relationship when applicable, and Drive view/download actions. Filters cover major categories such as games, covers and manuals, music, solutions, press, and fan works.

Unclassified files remain available in the complete archive browser. They appear in search when they contain indexable Hebrew metadata or text and are listed in the curator build report for optional enrichment.

## 10. Visual and editorial design

The site is Hebrew-first and fully RTL. Its visual direction is a modernized Piposh website:

- clean contemporary navigation, spacing, responsive layout, and search interaction;
- cream or white surfaces with strong black outlines;
- restrained lime, cyan, pink, and yellow accents inspired by original assets;
- occasional hand-drawn irregularity, not continuous visual noise;
- original Guillotine/Piposh imagery used faithfully rather than redrawn in a generic game style;
- preserved enclosed white details such as eyes and teeth when removing white image backgrounds;
- no unintended yellow tinting or blend-mode color shifts.

Homepage game tiles are cover-first. Each uses the full uncropped cover in a consistent frame, with a Hebrew title and compact factual badges below it. Badges may summarize available editions, audio discs, manuals, or other official material. Missing covers use a branded Piposh-style typographic fallback.

The copy uses the characters' mock-official, self-important, slightly exasperated voice. Humor is concise enough for navigation and accessibility. The signature phrase `קיבינימאט` appears intentionally, such as in the search prompt, rather than being repeated as decoration.

## 11. Game page behavior

A game page is an editorial hub, not a file listing. It contains:

- cover, title, year, and concise description;
- prominent supported-download guidance;
- official editions grouped clearly by language or release;
- official extras grouped by role: packaging, manuals, music, patches, solutions, and related release material;
- direct Drive actions on every file;
- factual metadata such as file type, size, and archive path;
- optional notes about compatibility or installation when curated.

The inverse relationship is also visible. For example, an official audio disc in the music area can show “part of the Piposh 1 release” and link back to the game page.

Press and fan items may carry topical Hebrew tags such as “about Piposh 1,” but are not rendered inside the Piposh 1 official-material groups.

## 12. Frontend architecture

Use Astro with TypeScript for pre-rendered routes and reusable layouts. Use a small client-side search component and a generated local search index. All primary pages and category navigation work without a server runtime.

Keep boundaries explicit:

- **Drive adapter**: retrieves and normalizes Drive metadata.
- **Text extractor**: extracts searchable Hebrew text from supported document formats.
- **Curator loader**: parses and validates editorial collection definitions.
- **Relationship resolver**: applies automatic rules and explicit overrides.
- **Catalog generator**: produces deterministic public JSON artifacts.
- **Search index builder**: normalizes Hebrew fields and assigns weights.
- **Site renderer**: produces static pages and optimized selected covers.
- **Deployment workflow**: validates, builds, and publishes the artifact.

The browser receives only generated public data. Large files, original scans, audio, and videos are never bundled into the Pages deployment.

## 13. Download behavior

Each item exposes the appropriate Google Drive action:

- “view in Drive” when Drive can preview the format;
- “download” for downloadable binary or media files;
- both actions when useful.

Google Drive remains responsible for large-file confirmation screens, quotas, and actual transfer. The site explains this in Hebrew so a Drive warning is not mistaken for an archive error.

## 14. Failure handling and validation

Blocking build checks include:

- Drive authentication or listing failure;
- an empty or implausibly small archive result;
- duplicate Drive IDs or collection slugs;
- malformed curator data;
- unresolved required cover or explicitly referenced file IDs;
- contradictory include/exclude relationships;
- missing generated search or catalog artifacts;
- failed Astro build or automated test suite.

Non-blocking conditions, such as newly discovered unclassified files, produce a curator report but do not prevent deployment.

If the search index fails to load in the browser, ordinary collection and category navigation remains usable. The user sees a clear Hebrew retry message instead of an empty result screen.

If a Drive file later becomes unavailable, its action leads to Drive's own unavailable-file response until the next daily sync removes or updates it. The build report highlights curated references that disappear.

## 15. Security and privacy

- Grant the service account read-only access only to the archive folder.
- Store the service-account JSON solely in GitHub Secrets.
- Never embed credentials, private API responses, or private file metadata in the build.
- Make public only the folder and files intended for public download.
- Keep dependencies pinned through the lockfile and use automated dependency alerts.

## 16. Accessibility and responsive behavior

- Semantic landmarks, headings, lists, links, and buttons.
- Full keyboard support with visible focus states.
- Hebrew labels and meaningful alternative text for covers and characters.
- Sufficient color contrast; color is never the only category signal.
- Reduced-motion behavior for decorative movement.
- Responsive layouts for phones, tablets, and desktop screens.
- Uncropped cover art remains legible, with contained scaling rather than destructive cropping.

## 17. Testing strategy

### Unit tests

- Hebrew normalization, including niqqud, punctuation, whitespace, and final letters.
- Search weighting and typo tolerance using representative Hebrew queries.
- Curator schema validation.
- Include, exclude, and relationship resolution.
- Drive path reconstruction and duplicate handling.
- Extraction of Hebrew text from supported fixtures.

### Integration tests

- A fixture Drive tree produces deterministic catalog and search artifacts.
- English-named foreign editions are returned for the correct Hebrew collection query through Hebrew metadata.
- Press and fan items tagged about a game never enter its `part-of-release` groups.
- Selected cover processing produces bounded, optimized outputs without changing original files.
- A failed sync cannot reach the deployment step.

### Browser and accessibility tests

- Homepage, category page, game page, and search result flow.
- Direct Drive actions contain the expected file ID.
- RTL layout at phone and desktop widths.
- Keyboard navigation, focus visibility, labels, and basic automated accessibility checks.
- Search-load failure fallback.

## 18. Setup and operator guidance

The repository README will guide the owner through:

1. creating or selecting a Google Cloud project;
2. enabling the Google Drive API;
3. creating a service account with no broad project permissions;
4. sharing only the public archive folder with that service account as viewer;
5. adding the service-account JSON to GitHub Secrets;
6. configuring the Drive root folder ID;
7. enabling GitHub Pages with GitHub Actions as the deployment source;
8. running the workflow manually for the first import;
9. reading sync failures and the curator report.

## 19. Acceptance criteria

- The site deploys successfully to GitHub Pages with no server runtime.
- A daily workflow discovers new Drive files and republishes only after validation.
- Every cataloged file has a working Drive view or download action derived from its Drive ID.
- The Piposh 1 page groups official editions, cover/manual material, audio disc, solution, and other official release items across Drive folders.
- Press coverage and fan works do not appear as Piposh 1 release attachments.
- A Hebrew search for `פיפוש 1` returns the collection first and can return English-named official edition files through Hebrew collection metadata.
- Homepage game tiles use uncropped covers with Hebrew text labels and factual badges.
- The site is fully RTL, keyboard usable, responsive, and visually consistent with the approved modern Piposh direction.
- A failed daily sync leaves the previous successful site online.
