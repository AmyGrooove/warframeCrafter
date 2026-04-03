import type { LocalizedNames, MasteryGroupId, MasteryItem } from "../types";
import { loadFromStorage, saveToStorage } from "./storage";

const MASTERY_DATASET_BASE = "https://cdn.jsdelivr.net/npm/warframe-items/data/json";
const MASTERY_IMAGE_BASE = "https://cdn.warframestat.us/img";
const MASTERY_ITEMS_API_BASE = "https://api.warframestat.us/items";
const MASTERY_TRANSLATIONS_URL = `${MASTERY_ITEMS_API_BASE}?language=ru`;
const MASTERY_LIVE_DATA_URL = `${MASTERY_ITEMS_API_BASE}?language=en`;
const MASTERY_CACHE_KEY = "wf-prime-tracker:mastery-catalog:v4";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const MASTERY_SOURCE_FILES = [
  "Warframes",
  "Primary",
  "Secondary",
  "Melee",
  "Arch-Gun",
  "Arch-Melee",
  "Archwing",
  "Sentinels",
  "SentinelWeapons",
  "Pets",
  "Misc",
] as const;

const COMPONENT_SUFFIXES = [
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
];

const COMPONENT_TYPE_MARKERS = [
  "blueprint",
  "component",
  "part",
  "parts",
  "resource",
  "quest",
  "relic",
  "arcane",
  "skin",
  "glyph",
  "sigil",
  "emblem",
  "ephemera",
];

type MasterySourceFile = (typeof MASTERY_SOURCE_FILES)[number];

interface CachedValue<T> {
  value: T;
  savedAt: number;
}

function isFresh(savedAt: number, ttl: number) {
  return Date.now() - savedAt < ttl;
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toMasteryReq(value: unknown) {
  return toOptionalNumber(value) ?? 0;
}

function normalizeKey(value: string | null) {
  return value ? value.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
}

function looksLikeComponent(name: string, typeLabel: string | null) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedType = normalizeKey(typeLabel);

  if (normalizedName.includes(":")) {
    return true;
  }

  if (
    COMPONENT_SUFFIXES.some(
      (suffix) =>
        normalizedName === suffix || normalizedName.endsWith(` ${suffix}`),
    )
  ) {
    return true;
  }

  return COMPONENT_TYPE_MARKERS.some((marker) =>
    normalizedType.includes(normalizeKey(marker)),
  );
}

function getMasteryGroup(source: MasterySourceFile): MasteryGroupId {
  if (source === "Warframes") {
    return "warframes";
  }

  if (source === "Primary") {
    return "primary";
  }

  if (source === "Secondary") {
    return "secondary";
  }

  if (source === "Melee") {
    return "melee";
  }

  if (source === "Arch-Gun") {
    return "archgun";
  }

  if (source === "Arch-Melee") {
    return "archmelee";
  }

  if (source === "Archwing") {
    return "archwing";
  }

  if (source === "SentinelWeapons") {
    return "companionWeapons";
  }

  if (source === "Sentinels" || source === "Pets") {
    return "companions";
  }

  return "other";
}

function getLiveMasteryGroup(candidate: Record<string, unknown>): MasteryGroupId | null {
  const categoryKey = normalizeKey(toOptionalString(candidate.category));
  const productCategoryKey = normalizeKey(toOptionalString(candidate.productCategory));
  const typeKey = normalizeKey(toOptionalString(candidate.type));
  const typeValue = (toOptionalString(candidate.type) ?? "").toLowerCase();

  if (
    categoryKey === "sentinelweapons" ||
    productCategoryKey === "sentinelweapons"
  ) {
    return "companionWeapons";
  }

  if (categoryKey === "archgun" || productCategoryKey === "spaceguns") {
    return "archgun";
  }

  if (categoryKey === "archmelee" || productCategoryKey === "spacemelee") {
    return "archmelee";
  }

  if (categoryKey === "archwing" || productCategoryKey === "spacesuits") {
    return "archwing";
  }

  if (
    productCategoryKey === "mechsuits" ||
    categoryKey === "necramechs" ||
    categoryKey === "amps" ||
    categoryKey === "kdrives"
  ) {
    return "other";
  }

  if (
    categoryKey === "sentinels" ||
    categoryKey === "pets" ||
    categoryKey === "companions" ||
    productCategoryKey === "sentinels" ||
    productCategoryKey === "pets" ||
    productCategoryKey === "companions" ||
    ["kubrow", "kavat", "hound", "moa", "vulpaphyla", "predasite"].includes(
      typeKey,
    )
  ) {
    return "companions";
  }

  if (categoryKey === "primary" || productCategoryKey === "longguns") {
    return "primary";
  }

  if (categoryKey === "secondary" || productCategoryKey === "pistols") {
    return "secondary";
  }

  if (categoryKey === "melee" || productCategoryKey === "melee") {
    return "melee";
  }

  if (categoryKey === "warframes" || productCategoryKey === "suits") {
    return "warframes";
  }

  if (typeValue.includes("sentinel weapon")) {
    return "companionWeapons";
  }

  if (
    typeValue.includes("arch-gun") ||
    typeValue.includes("archgun")
  ) {
    return "archgun";
  }

  if (
    typeValue.includes("arch-melee") ||
    typeValue.includes("archmelee")
  ) {
    return "archmelee";
  }

  if (typeValue.includes("archwing")) {
    return "archwing";
  }

  if (
    typeValue.includes("sentinel") ||
    typeValue.includes("kubrow") ||
    typeValue.includes("kavat") ||
    typeValue.includes("hound") ||
    typeValue.includes("predasite") ||
    typeValue.includes("vulpaphyla") ||
    typeValue.includes("moa") ||
    typeValue.includes("companion")
  ) {
    return "companions";
  }

  if (typeValue.includes("warframe")) {
    return "warframes";
  }

  return null;
}

function normalizeTranslationMap(payload: unknown) {
  const namesByUniqueName = new Map<string, string>();

  if (!Array.isArray(payload)) {
    return namesByUniqueName;
  }

  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const uniqueName = toOptionalString(candidate.uniqueName);
    const name = toOptionalString(candidate.name);

    if (uniqueName && name) {
      namesByUniqueName.set(uniqueName, name);
    }
  }

  return namesByUniqueName;
}

function toLocalizedNames(name: string, uniqueName: string | null, russianNames: Map<string, string>) {
  const names: LocalizedNames = { en: name };

  if (uniqueName && russianNames.has(uniqueName)) {
    names.ru = russianNames.get(uniqueName) ?? undefined;
  }

  return names;
}

function normalizeImageUrl(value: string | null) {
  if (!value) {
    return null;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return value.startsWith("/") ? `${MASTERY_IMAGE_BASE}${value}` : `${MASTERY_IMAGE_BASE}/${value}`;
}

function normalizeMasteryItem(
  record: unknown,
  source: MasterySourceFile,
  russianNames: Map<string, string>,
): MasteryItem | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const candidate = record as Record<string, unknown>;

  if (candidate.masterable !== true) {
    return null;
  }

  const name = toOptionalString(candidate.name);
  const uniqueName = toOptionalString(candidate.uniqueName);
  const imageName = toOptionalString(candidate.imageName);
  const wikiaThumbnail = toOptionalString(candidate.wikiaThumbnail);

  if (!name) {
    return null;
  }

  return {
    id: uniqueName ?? `${source}:${name}`,
    name,
    names: toLocalizedNames(name, uniqueName, russianNames),
    description: toOptionalString(candidate.description),
    masteryReq: toMasteryReq(candidate.masteryReq),
    group: getMasteryGroup(source),
    sourceCategory: source,
    typeLabel: toOptionalString(candidate.type) ?? source,
    imageUrl: imageName ? `${MASTERY_IMAGE_BASE}/${imageName}` : wikiaThumbnail,
    fallbackImageUrl: imageName ? wikiaThumbnail : null,
    wikiUrl: toOptionalString(candidate.wikiaUrl),
  };
}

function normalizeLiveMasteryItem(
  record: unknown,
  russianNames: Map<string, string>,
): MasteryItem | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const candidate = record as Record<string, unknown>;
  const name = toOptionalString(candidate.name);
  const uniqueName = toOptionalString(candidate.uniqueName);
  const group = getLiveMasteryGroup(candidate);
  const typeLabel = toOptionalString(candidate.type);
  const masteryReq = toOptionalNumber(candidate.masteryReq) ?? toOptionalNumber(candidate.mr) ?? 0;
  const masterable = candidate.masterable === true;

  if (!name || !group || looksLikeComponent(name, typeLabel)) {
    return null;
  }

  if (!masterable && toOptionalNumber(candidate.masteryReq) === null && toOptionalNumber(candidate.mr) === null) {
    return null;
  }

  const imageUrl =
    normalizeImageUrl(toOptionalString(candidate.thumbnail)) ??
    normalizeImageUrl(toOptionalString(candidate.imageName));
  const fallbackImageUrl = normalizeImageUrl(toOptionalString(candidate.wikiaThumbnail));
  const sourceCategory =
    toOptionalString(candidate.category) ??
    toOptionalString(candidate.productCategory) ??
    "WarframeStat";

  return {
    id: uniqueName ?? `WarframeStat:${name}`,
    name,
    names: toLocalizedNames(name, uniqueName, russianNames),
    description: toOptionalString(candidate.description),
    masteryReq,
    group,
    sourceCategory,
    typeLabel: typeLabel ?? sourceCategory,
    imageUrl,
    fallbackImageUrl,
    wikiUrl: toOptionalString(candidate.wikiaUrl) ?? toOptionalString(candidate.url),
  };
}

function mergeMasteryItem(existing: MasteryItem, next: MasteryItem): MasteryItem {
  return {
    ...existing,
    names: {
      ...next.names,
      ...existing.names,
    },
    description: existing.description ?? next.description,
    masteryReq: Math.max(existing.masteryReq, next.masteryReq),
    group: existing.group === "other" && next.group !== "other" ? next.group : existing.group,
    sourceCategory: existing.sourceCategory || next.sourceCategory,
    typeLabel: existing.typeLabel || next.typeLabel,
    imageUrl: existing.imageUrl ?? next.imageUrl,
    fallbackImageUrl: existing.fallbackImageUrl ?? next.fallbackImageUrl,
    wikiUrl: existing.wikiUrl ?? next.wikiUrl,
  };
}

function upsertMasteryItems(catalogMap: Map<string, MasteryItem>, items: MasteryItem[]) {
  for (const item of items) {
    const current = catalogMap.get(item.id);

    if (!current) {
      catalogMap.set(item.id, item);
      continue;
    }

    catalogMap.set(item.id, mergeMasteryItem(current, item));
  }
}

async function fetchMasterySource(
  source: MasterySourceFile,
  russianNames: Map<string, string>,
) {
  const response = await fetch(`${MASTERY_DATASET_BASE}/${source}.json`);

  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${source}: ${response.status}`);
  }

  const data = (await response.json()) as unknown;

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((entry) => normalizeMasteryItem(entry, source, russianNames))
    .filter((entry): entry is MasteryItem => entry !== null);
}

async function fetchLiveMasteryItems(russianNames: Map<string, string>) {
  const response = await fetch(MASTERY_LIVE_DATA_URL);

  if (!response.ok) {
    throw new Error(`Не удалось загрузить live-каталог mastery: ${response.status}`);
  }

  const data = (await response.json()) as unknown;

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((entry) => normalizeLiveMasteryItem(entry, russianNames))
    .filter((entry): entry is MasteryItem => entry !== null);
}

export async function fetchMasteryCatalog(): Promise<MasteryItem[]> {
  const cached = loadFromStorage<CachedValue<MasteryItem[]> | null>(
    MASTERY_CACHE_KEY,
    null,
  );

  if (cached && isFresh(cached.savedAt, DAY_IN_MS) && cached.value.length > 0) {
    return cached.value;
  }

  let russianNames = new Map<string, string>();

  try {
    const response = await fetch(MASTERY_TRANSLATIONS_URL);

    if (response.ok) {
      russianNames = normalizeTranslationMap((await response.json()) as unknown);
    }
  } catch {
    // Fall back to English-only names when the translation source is unavailable.
  }

  const settled = await Promise.allSettled([
    ...MASTERY_SOURCE_FILES.map((source) => fetchMasterySource(source, russianNames)),
    fetchLiveMasteryItems(russianNames),
  ]);
  const catalogMap = new Map<string, MasteryItem>();

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }

    upsertMasteryItems(catalogMap, result.value);
  }

  const items = [...catalogMap.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "en", { numeric: true }),
  );

  if (items.length === 0) {
    throw new Error("Не удалось загрузить каталог осваиваемых предметов");
  }

  saveToStorage(MASTERY_CACHE_KEY, {
    value: items,
    savedAt: Date.now(),
  } satisfies CachedValue<MasteryItem[]>);

  return items;
}
