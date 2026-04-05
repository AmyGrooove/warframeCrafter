import type { MarketItem } from "../types";

const WIKI_API_BASE =
  import.meta.env.VITE_WARFRAME_WIKI_API_BASE ?? "https://wiki.warframe.com/api.php";

export const PRIME_COMPONENT_SUFFIXES = [
  "blueprint",
  "chassis",
  "neuroptics",
  "systems",
  "harness",
  "cerebrum",
  "carapace",
  "barrel",
  "receiver",
  "stock",
  "blade",
  "handle",
  "disc",
  "ornament",
  "string",
  "grip",
  "link",
  "loader",
  "gauntlet",
  "hilt",
  "pouch",
  "head",
  "tail",
  "casing",
  "core",
  "engine",
  "rotor",
  "pod",
  "brace",
  "chamber",
  "prism",
  "scaffold",
  "certus",
  "clapkra",
  "lohrin",
  "pencha",
  "phahd",
  "klebrik",
  "shwaak",
  "rahn",
  "lega",
  "cantic",
  "propa",
  "sirocco",
] as const;

export interface WikiCraftingIngredient {
  name: string;
  slug: string;
  quantity: number;
}

export interface WikiPageData {
  title: string;
  candidateTitles: string[];
  ingredients: WikiCraftingIngredient[];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function trimTrailingWord(value: string, word: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  const standalonePattern = new RegExp(`^${word}$`, "i");

  if (standalonePattern.test(trimmedValue)) {
    return "";
  }

  const trailingPattern = new RegExp(`\\s+${word}$`, "i");
  return trimmedValue.replace(trailingPattern, "").trim();
}

export function normalizeWikiPageTitle(value: string) {
  return value
    .replace(/\s*\(x\d+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function addWikiPageTitleCandidate(candidates: Set<string>, value: string) {
  const normalizedValue = normalizeWikiPageTitle(value);

  if (!normalizedValue) {
    return;
  }

  if (normalizedValue.includes("/")) {
    candidates.add(normalizedValue);
    candidates.add(normalizedValue.replace(/\//g, " "));
    return;
  }

  const primeSlashVariant = normalizedValue.replace(/\s+Prime$/i, "/Prime");

  if (primeSlashVariant !== normalizedValue) {
    candidates.add(primeSlashVariant);
    candidates.add(normalizedValue);
    candidates.add(primeSlashVariant.replace(/\//g, " "));
    return;
  }

  candidates.add(normalizedValue);
}

export function deriveWikiPageTitleCandidates(value: string) {
  const candidates = new Set<string>();
  let current = normalizeWikiPageTitle(value);

  if (!current) {
    return [];
  }

  addWikiPageTitleCandidate(candidates, current);

  let didChange = true;

  while (didChange && current.length > 0) {
    didChange = false;

    const withoutSet = trimTrailingWord(current, "set");

    if (withoutSet !== current) {
      current = normalizeWikiPageTitle(withoutSet);
      if (current) {
        addWikiPageTitleCandidate(candidates, current);
      }
      didChange = true;
      continue;
    }

    for (const suffix of PRIME_COMPONENT_SUFFIXES) {
      const stripped = trimTrailingWord(current, suffix);

      if (stripped !== current) {
        current = normalizeWikiPageTitle(stripped);
        if (current) {
          addWikiPageTitleCandidate(candidates, current);
        }
        didChange = true;
        break;
      }
    }
  }

  return [...candidates];
}

export function extractWikiPageCandidateTitles(text: string) {
  const candidates = new Set<string>();
  const patterns = [
    /(?:crafting|requisite)\s+ingredient for\s+([A-Z][^.\n;]+?)(?=\s*(?:[.,;]|$))/gi,
    /(?:ingredient for|required for|used to craft|used in crafting)\s+([A-Z][^.\n;]+?)(?=\s*(?:[.,;]|$))/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text))) {
      const candidate = normalizeWikiPageTitle(match[1]);

      if (candidate) {
        candidates.add(candidate);
      }
    }
  }

  return [...candidates];
}

function normalizeComparisonText(value: string) {
  return normalizeWikiPageTitle(value)
    .toLowerCase()
    .replace(/[\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCraftingResultLink(rawName: string, candidateTitles: string[]) {
  const normalizedName = normalizeComparisonText(rawName);

  if (!normalizedName) {
    return false;
  }

  for (const candidateTitle of candidateTitles) {
    const normalizedCandidate = normalizeComparisonText(candidateTitle);

    if (!normalizedCandidate) {
      continue;
    }

    if (normalizedName === normalizedCandidate) {
      return true;
    }

    if (normalizedName === `${normalizedCandidate} blueprint`) {
      return true;
    }
  }

  return false;
}

function isArticleLink(href: string | null) {
  if (!href) {
    return false;
  }

  return (
    href.includes("/wiki/") &&
    !href.includes("/wiki/File:") &&
    !href.includes("/wiki/Special:") &&
    !href.includes("/wiki/Category:")
  );
}

function extractNumericCellValue(cellText: string) {
  const normalizedText = cellText.replace(/\s+/g, " ").trim();

  if (!/^\d[\d,]*$/.test(normalizedText)) {
    return null;
  }

  const parsed = Number.parseInt(normalizedText.replace(/,/g, ""), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractQuantityFromRow(cells: HTMLTableCellElement[], linkCellIndex: number) {
  const searchOrder: number[] = [];

  for (let offset = 1; offset < cells.length; offset += 1) {
    const rightIndex = linkCellIndex + offset;
    const leftIndex = linkCellIndex - offset;

    if (rightIndex < cells.length) {
      searchOrder.push(rightIndex);
    }

    if (leftIndex >= 0) {
      searchOrder.push(leftIndex);
    }
  }

  for (const index of searchOrder) {
    const quantity = extractNumericCellValue(cells[index]?.textContent ?? "");

    if (quantity !== null) {
      return quantity;
    }
  }

  const linkCellText = cells[linkCellIndex]?.textContent ?? "";
  const linkCellMatch = linkCellText.match(/\b\d[\d,]*\b/);

  if (linkCellMatch) {
    const parsed = Number.parseInt(linkCellMatch[0].replace(/,/g, ""), 10);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 1;
}

interface WikiQueryPage {
  pageid?: number;
  title?: string;
  missing?: boolean;
  invalid?: boolean;
}

interface WikiQueryResponse {
  query?: {
    pages?: WikiQueryPage[];
  };
  error?: {
    code?: string;
    info?: string;
  };
}

interface WikiParseResponse {
  parse?: {
    title?: string;
    text?: {
      ["*"]?: string;
    };
  };
  error?: {
    code?: string;
    info?: string;
  };
}

interface WikiResolvedPage {
  pageId: number;
  title: string;
}

interface BlueprintModulePart {
  count: number;
  name: string;
  type: string;
}

interface BlueprintModuleEntry {
  key: string;
  name: string;
  result: string;
  productCategory: string | null;
  parts: BlueprintModulePart[];
}

let blueprintModuleEntriesPromise: Promise<BlueprintModuleEntry[]> | null = null;

async function resolveWikiPage(
  pageTitle: string,
  signal?: AbortSignal,
): Promise<WikiResolvedPage | null> {
  const url = new URL(WIKI_API_BASE);
  url.search = new URLSearchParams({
    origin: "*",
    action: "query",
    titles: pageTitle,
    redirects: "1",
    prop: "info",
    format: "json",
    formatversion: "2",
  }).toString();

  const response = await fetch(url.toString(), {
    mode: "cors",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Wiki request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as WikiQueryResponse;
  const pages = payload.query?.pages;

  if (!Array.isArray(pages)) {
    return null;
  }

  const page = pages.find(
    (entry) =>
      typeof entry.pageid === "number" &&
      Number.isFinite(entry.pageid) &&
      entry.pageid > 0 &&
      !entry.missing &&
      !entry.invalid &&
      typeof entry.title === "string" &&
      entry.title.length > 0,
  );

  if (!page || typeof page.pageid !== "number" || !page.title) {
    return null;
  }

  return {
    pageId: page.pageid,
    title: page.title,
  };
}

async function parseWikiPage(
  pageId: number,
  signal?: AbortSignal,
): Promise<WikiParseResponse | null> {
  const url = new URL(WIKI_API_BASE);
  url.search = new URLSearchParams({
    origin: "*",
    action: "parse",
    pageid: String(pageId),
    prop: "text",
    redirects: "1",
    format: "json",
  }).toString();

  const response = await fetch(url.toString(), {
    mode: "cors",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Wiki request failed with status ${response.status}`);
  }

  return (await response.json()) as WikiParseResponse;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipLuaTrivia(text: string, startIndex: number) {
  let index = startIndex;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "," || /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      if (text.startsWith("--[[", index)) {
        const endIndex = text.indexOf("]]", index + 4);
        index = endIndex === -1 ? text.length : endIndex + 2;
      } else {
        const endIndex = text.indexOf("\n", index + 2);
        index = endIndex === -1 ? text.length : endIndex + 1;
      }

      continue;
    }

    break;
  }

  return index;
}

function findMatchingLuaBrace(text: string, openIndex: number) {
  if (text[openIndex] !== "{") {
    return -1;
  }

  let depth = 0;
  let index = openIndex;
  let stringDelimiter: "'" | "\"" | null = null;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (stringDelimiter) {
      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === stringDelimiter) {
        stringDelimiter = null;
      }

      index += 1;
      continue;
    }

    if (char === "'" || char === "\"") {
      stringDelimiter = char;
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      if (text.startsWith("--[[", index)) {
        const endIndex = text.indexOf("]]", index + 4);
        index = endIndex === -1 ? text.length : endIndex + 2;
      } else {
        const endIndex = text.indexOf("\n", index + 2);
        index = endIndex === -1 ? text.length : endIndex + 1;
      }

      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }

    index += 1;
  }

  return -1;
}

function extractLuaFieldString(body: string, fieldName: string) {
  const pattern = new RegExp(`\\b${escapeRegExp(fieldName)}\\s*=\\s*"([^"]*)"`, "m");
  const match = body.match(pattern);
  return match?.[1] ?? null;
}

function extractLuaFieldBlock(body: string, fieldName: string) {
  const pattern = new RegExp(`\\b${escapeRegExp(fieldName)}\\s*=\\s*\\{`, "m");
  const match = pattern.exec(body);

  if (!match) {
    return null;
  }

  const openIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingLuaBrace(body, openIndex);

  if (closeIndex < 0) {
    return null;
  }

  return body.slice(openIndex + 1, closeIndex);
}

function parseLuaArrayEntries<T>(
  block: string,
  parser: (body: string) => T | null,
) {
  const entries: T[] = [];
  let index = 0;

  while (index < block.length) {
    index = skipLuaTrivia(block, index);

    if (index >= block.length) {
      break;
    }

    if (block[index] !== "{") {
      index += 1;
      continue;
    }

    const closeIndex = findMatchingLuaBrace(block, index);

    if (closeIndex < 0) {
      break;
    }

    const entry = parser(block.slice(index + 1, closeIndex));

    if (entry) {
      entries.push(entry);
    }

    index = closeIndex + 1;
  }

  return entries;
}

function parseBlueprintModulePart(body: string) {
  const countMatch = body.match(/\bCount\s*=\s*(\d+)/);
  const name = extractLuaFieldString(body, "Name");
  const type = extractLuaFieldString(body, "Type");

  if (!countMatch || !name || !type) {
    return null;
  }

  return {
    count: Number.parseInt(countMatch[1], 10),
    name,
    type,
  } satisfies BlueprintModulePart;
}

function parseBlueprintModuleEntry(key: string, body: string) {
  const name = extractLuaFieldString(body, "Name");
  const result = extractLuaFieldString(body, "Result");

  if (!name || !result) {
    return null;
  }

  const productCategory = extractLuaFieldString(body, "ProductCategory");
  const partsBlock = extractLuaFieldBlock(body, "Parts");
  const parts = partsBlock
    ? parseLuaArrayEntries(partsBlock, parseBlueprintModulePart)
    : [];

  return {
    key,
    name,
    result,
    productCategory,
    parts,
  } satisfies BlueprintModuleEntry;
}

function parseBlueprintModuleEntries(source: string) {
  const returnIndex = source.indexOf("return {");
  const openIndex = returnIndex === -1 ? -1 : source.indexOf("{", returnIndex);
  const closeIndex = openIndex >= 0 ? findMatchingLuaBrace(source, openIndex) : -1;
  const dataBlock =
    openIndex >= 0 && closeIndex >= 0
      ? source.slice(openIndex + 1, closeIndex)
      : source;
  const blueprintsBlock = extractLuaFieldBlock(dataBlock, "Blueprints");
  const suitsBlock = extractLuaFieldBlock(dataBlock, "Suits");
  const blocks = [blueprintsBlock, suitsBlock].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const entries: BlueprintModuleEntry[] = [];

  for (const block of blocks) {
    let index = 0;

    while (index < block.length) {
      index = skipLuaTrivia(block, index);

      if (index >= block.length) {
        break;
      }

      const slice = block.slice(index);
      const match = slice.match(
        /^(?:\[\s*"([^"]+)"\s*\]|([A-Za-z0-9_]+))\s*=\s*\{/,
      );

      if (!match) {
        index += 1;
        continue;
      }

      const key = match[1] ?? match[2];
      const openIndex = index + match[0].length - 1;
      const closeIndex = findMatchingLuaBrace(block, openIndex);

      if (closeIndex < 0) {
        break;
      }

      const entry = parseBlueprintModuleEntry(key, block.slice(openIndex + 1, closeIndex));

      if (entry) {
        entries.push(entry);
      }

      index = closeIndex + 1;
    }
  }

  return entries;
}

async function fetchBlueprintModuleEntries(signal?: AbortSignal) {
  if (!blueprintModuleEntriesPromise) {
    blueprintModuleEntriesPromise = (async () => {
      const url = new URL(WIKI_API_BASE);
      url.search = new URLSearchParams({
        origin: "*",
        action: "query",
        titles: "Module:Blueprints/data",
        prop: "revisions",
        rvslots: "main",
        rvprop: "content",
        format: "json",
        formatversion: "2",
      }).toString();

      const response = await fetch(url.toString(), {
        mode: "cors",
        signal,
      });

      if (!response.ok) {
        throw new Error(`Wiki request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        query?: {
          pages?: Array<{
            revisions?: Array<{
              slots?: {
                main?: {
                  content?: string;
                };
              };
            }>;
          }>;
        };
      };

      const pages = payload.query?.pages ?? [];
      const content = pages
        .map((page) => page.revisions?.[0]?.slots?.main?.content ?? null)
        .find((value): value is string => typeof value === "string" && value.length > 0);

      if (!content) {
        return [];
      }

      return parseBlueprintModuleEntries(content);
    })().catch((error) => {
      blueprintModuleEntriesPromise = null;
      throw error;
    });
  }

  return blueprintModuleEntriesPromise;
}

function normalizeBlueprintLookupText(value: string) {
  return normalizeWikiPageTitle(value)
    .toLowerCase()
    .replace(/[\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimBlueprintSuffix(value: string) {
  return value.replace(/\s+blueprint$/i, "").trim();
}

function buildRequiredBlueprintName(resultName: string, partName: string) {
  const trimmedPartName = partName.replace(/^Prime\s+/i, "").trim();

  if (!trimmedPartName) {
    return null;
  }

  return `${resultName.trim()} ${trimmedPartName} Blueprint`;
}

function findBlueprintModuleEntry(
  entries: BlueprintModuleEntry[],
  title: string,
) {
  const normalizedTitle = normalizeBlueprintLookupText(title);

  if (!normalizedTitle) {
    return null;
  }

  return (
    entries.find((entry) => {
      const candidates = [
        entry.key,
        entry.result,
        entry.name,
        trimBlueprintSuffix(entry.name),
      ].map(normalizeBlueprintLookupText);

      return candidates.some((candidate) => candidate === normalizedTitle);
    }) ?? null
  );
}

function parseRequirementsTable(
  table: HTMLTableElement,
  candidateTitles: string[],
  resolveItem: (name: string) => MarketItem | null | undefined,
) {
  const requirements = new Map<string, WikiCraftingIngredient>();

  for (const row of table.querySelectorAll("tr")) {
    const cells = Array.from(row.querySelectorAll("th, td")) as HTMLTableCellElement[];
    const links: Array<{
      cellIndex: number;
      rawName: string;
    }> = [];

    if (cells.length === 0) {
      continue;
    }

    for (let index = 0; index < cells.length; index += 1) {
      for (const anchor of Array.from(cells[index].querySelectorAll("a"))) {
        if (!isArticleLink(anchor.getAttribute("href"))) {
          continue;
        }

        const rawName = normalizeWikiPageTitle(anchor.textContent ?? "");

        if (!rawName) {
          continue;
        }

        links.push({
          cellIndex: index,
          rawName,
        });
      }
    }

    if (links.length === 0) {
      continue;
    }

    const resultLinkIndex = links.findIndex((entry) =>
      isCraftingResultLink(entry.rawName, candidateTitles),
    );

    for (const [linkIndex, entry] of links.entries()) {
      if (linkIndex === resultLinkIndex) {
        continue;
      }

      const item = resolveItem(entry.rawName);

      if (!item) {
        continue;
      }

      const quantity = extractQuantityFromRow(cells, entry.cellIndex);
      const current = requirements.get(item.slug);

      if (!current) {
        requirements.set(item.slug, {
          name: item.name,
          slug: item.slug,
          quantity,
        });
        continue;
      }

      current.quantity += quantity;
    }
  }

  return [...requirements.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ru"),
  );
}

function findSectionHeading(root: HTMLElement, headingText: string) {
  const normalizedHeading = normalizeText(headingText);

  return Array.from(root.children).find((element) => {
    if (!/^H[1-6]$/i.test(element.tagName)) {
      return false;
    }

    return normalizeText(element.textContent ?? "").includes(normalizedHeading);
  }) as HTMLElement | undefined;
}

function extractSectionRequirements(
  root: HTMLElement,
  candidateTitles: string[],
  resolveItem: (name: string) => MarketItem | null | undefined,
) {
  const headings = ["Manufacturing Requirements", "Crafting"];

  for (const headingText of headings) {
    const heading = findSectionHeading(root, headingText);

    if (!heading) {
      continue;
    }

    const children = Array.from(root.children);
    const headingIndex = children.indexOf(heading);

    for (let index = headingIndex + 1; index < children.length; index += 1) {
      const child = children[index];

      if (/^H[1-6]$/i.test(child.tagName)) {
        break;
      }

      const table =
        child.tagName === "TABLE"
          ? (child as HTMLTableElement)
          : (child.querySelector("table") as HTMLTableElement | null);

      if (!table) {
        continue;
      }

      const requirements = parseRequirementsTable(table, candidateTitles, resolveItem);

      if (requirements.length > 0) {
        return requirements;
      }
    }
  }

  return [];
}

export async function fetchWikiPageData(
  pageTitle: string,
  resolveItem: (name: string) => MarketItem | null | undefined,
  signal?: AbortSignal,
): Promise<WikiPageData | null> {
  const entries = await fetchBlueprintModuleEntries(signal);
  const candidateTitles = deriveWikiPageTitleCandidates(pageTitle);

  for (const candidateTitle of candidateTitles) {
    const entry = findBlueprintModuleEntry(entries, candidateTitle);

    if (!entry) {
      continue;
    }

    const requiredItems = new Map<string, WikiCraftingIngredient>();
    const mainBlueprint = resolveItem(entry.name);

    if (!mainBlueprint) {
      continue;
    }

    requiredItems.set(mainBlueprint.slug, {
      name: mainBlueprint.name,
      slug: mainBlueprint.slug,
      quantity: 1,
    });

    let failed = false;

    for (const part of entry.parts) {
      if (part.type === "Resource") {
        continue;
      }

      const blueprintName = buildRequiredBlueprintName(entry.result, part.name);

      if (!blueprintName) {
        failed = true;
        break;
      }

      const item = resolveItem(blueprintName);

      if (!item) {
        failed = true;
        break;
      }

      const current = requiredItems.get(item.slug);

      if (!current) {
        requiredItems.set(item.slug, {
          name: item.name,
          slug: item.slug,
          quantity: part.count,
        });
        continue;
      }

      current.quantity += part.count;
    }

    if (failed || requiredItems.size === 0) {
      continue;
    }

    return {
      title: entry.result,
      candidateTitles: [],
      ingredients: [...requiredItems.values()].sort((left, right) =>
        left.name.localeCompare(right.name, "ru"),
      ),
    };
  }

  return null;
}
