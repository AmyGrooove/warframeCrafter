import type {
  LocalizedNames,
  MarketAssets,
  MarketItem,
  PriceSnapshot,
} from "../types";
import { loadFromStorage, saveToStorage } from "./storage";

const API_BASE =
  import.meta.env.VITE_WARFRAME_API_BASE ?? "/api/warframe-market/v2";
const ASSET_BASE = "https://warframe.market/static/assets";

const ITEM_CACHE_KEY = "wf-prime-tracker:item-catalog:v3";
const PRICE_CACHE_KEY = "wf-prime-tracker:price-cache:v1";
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const PRICE_CACHE_MS = 5 * 60 * 1000;

interface CachedValue<T> {
  value: T;
  savedAt: number;
}

interface OrderPayload {
  platinum?: number;
  orderType?: string;
  order_type?: string;
  user?: {
    ingameName?: string;
    status?: string;
  };
}

function isFresh(savedAt: number, ttl: number) {
  return Date.now() - savedAt < ttl;
}

function toAssetUrl(path: unknown) {
  return typeof path === "string" && path.length > 0
    ? `${ASSET_BASE}/${path}`
    : null;
}

function normalizeItem(record: unknown): MarketItem | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const candidate = record as Record<string, unknown>;
  const slug = candidate.urlName ?? candidate.url_name ?? candidate.slug;
  const i18nValue =
    candidate.i18n && typeof candidate.i18n === "object"
      ? (candidate.i18n as Record<string, unknown>)
      : null;
  const englishI18n =
    i18nValue?.en && typeof i18nValue.en === "object"
      ? (i18nValue.en as Record<string, unknown>)
      : null;
  const russianI18n =
    i18nValue?.ru && typeof i18nValue.ru === "object"
      ? (i18nValue.ru as Record<string, unknown>)
      : null;
  const englishName =
    (englishI18n?.itemName ?? englishI18n?.name) || null;
  const russianName =
    (russianI18n?.itemName ?? russianI18n?.name) || null;
  const thumbPath = russianI18n?.thumb ?? englishI18n?.thumb ?? null;
  const iconPath = russianI18n?.icon ?? englishI18n?.icon ?? null;
  const badgePath = russianI18n?.subIcon ?? englishI18n?.subIcon ?? null;
  const name =
    candidate.itemName ??
    candidate.item_name ??
    candidate.name ??
    englishName ??
    russianName;
  const rawId = candidate.id ?? candidate._id ?? slug;
  const id =
    typeof rawId === "string" || typeof rawId === "number"
      ? String(rawId)
      : null;

  if (
    typeof slug !== "string" ||
    typeof name !== "string" ||
    id === null
  ) {
    return null;
  }

  const normalizedEnglishName =
    typeof englishName === "string" ? englishName : name;

  if (!normalizedEnglishName.toLowerCase().includes("prime")) {
    return null;
  }

  if (
    normalizedEnglishName.includes("Relic") ||
    normalizedEnglishName.includes("Prime Access")
  ) {
    return null;
  }

  const names: LocalizedNames = {
    en: normalizedEnglishName,
    ...(typeof russianName === "string" ? { ru: russianName } : {}),
  };
  const assets: MarketAssets = {
    thumb: toAssetUrl(thumbPath),
    icon: toAssetUrl(iconPath),
    badge: toAssetUrl(badgePath),
  };

  return {
    id,
    slug,
    name: normalizedEnglishName,
    names,
    assets,
  };
}

function extractItems(payload: unknown): MarketItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;
  const candidates = [
    root.data,
    root.items,
    root.payload,
    root.payload && typeof root.payload === "object"
      ? (root.payload as Record<string, unknown>).items
      : null,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const normalized = candidate
      .map((entry) => normalizeItem(entry))
      .filter((entry): entry is MarketItem => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function pickOnlineOrders(orders: OrderPayload[]) {
  const online = orders.filter((order) => {
    const status = order.user?.status?.toLowerCase();
    return status === "ingame" || status === "online";
  });

  return online.length > 0 ? online : orders;
}

function minPlatinum(orders: OrderPayload[]) {
  const values = orders
    .map((order) => order.platinum)
    .filter((value): value is number => typeof value === "number");

  return values.length > 0 ? Math.min(...values) : null;
}

function maxPlatinum(orders: OrderPayload[]) {
  const values = orders
    .map((order) => order.platinum)
    .filter((value): value is number => typeof value === "number");

  return values.length > 0 ? Math.max(...values) : null;
}

function extractOrders(payload: unknown, type: "sell" | "buy"): OrderPayload[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;
  const nestedData =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : null;
  const payloadData =
    root.payload && typeof root.payload === "object"
      ? (root.payload as Record<string, unknown>)
      : null;

  const candidates = [
    root[type],
    nestedData?.[type],
    payloadData?.[type],
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const orders = candidate.filter(
      (entry): entry is OrderPayload =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    );

    if (orders.length > 0) {
      return orders;
    }
  }

  if (Array.isArray(payloadData?.orders)) {
    return payloadData.orders.filter((entry): entry is OrderPayload => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }

      const order = entry as OrderPayload;
      const orderType = order.orderType ?? order.order_type;
      return orderType === type;
    });
  }

  return [];
}

export async function fetchPrimeCatalog(): Promise<MarketItem[]> {
  const cached = loadFromStorage<CachedValue<MarketItem[]> | null>(
    ITEM_CACHE_KEY,
    null,
  );

  if (cached && isFresh(cached.savedAt, DAY_IN_MS) && cached.value.length > 0) {
    return cached.value;
  }

  const response = await fetch(`${API_BASE}/items`, {
    headers: {
      Language: "ru",
    },
  });

  if (!response.ok) {
    throw new Error(`Не удалось загрузить список предметов: ${response.status}`);
  }

  const data = (await response.json()) as unknown;
  const items = extractItems(data);

  if (items.length === 0) {
    throw new Error("API вернул пустой каталог прайм-предметов");
  }

  saveToStorage(ITEM_CACHE_KEY, {
    value: items,
    savedAt: Date.now(),
  } satisfies CachedValue<MarketItem[]>);

  return items;
}

export async function fetchPrimePrice(
  item: Pick<MarketItem, "slug" | "name">,
  options?: { force?: boolean },
): Promise<PriceSnapshot> {
  const cachedPrices = loadFromStorage<Record<string, CachedValue<PriceSnapshot>>>(
    PRICE_CACHE_KEY,
    {},
  );
  const cached = cachedPrices[item.slug];

  if (cached && !options?.force && isFresh(cached.savedAt, PRICE_CACHE_MS)) {
    return cached.value;
  }

  const response = await fetch(`${API_BASE}/orders/item/${item.slug}/top`);

  if (!response.ok) {
    throw new Error(`Не удалось загрузить цену: ${response.status}`);
  }

  const data = (await response.json()) as unknown;
  const sellOrders = pickOnlineOrders(extractOrders(data, "sell"));
  const buyOrders = pickOnlineOrders(extractOrders(data, "buy"));

  const snapshot: PriceSnapshot = {
    slug: item.slug,
    name: item.name,
    minSellPrice: minPlatinum(sellOrders),
    maxBuyPrice: maxPlatinum(buyOrders),
    sellOrderCount: sellOrders.length,
    buyOrderCount: buyOrders.length,
    bestSeller: sellOrders[0]?.user?.ingameName ?? null,
    updatedAt: new Date().toISOString(),
  };

  saveToStorage(PRICE_CACHE_KEY, {
    ...cachedPrices,
    [item.slug]: {
      value: snapshot,
      savedAt: Date.now(),
    },
  });

  return snapshot;
}
