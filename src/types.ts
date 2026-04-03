export type AppLocale = "ru" | "en";

export interface LocalizedNames {
  en: string;
  ru?: string;
}

export interface MarketAssets {
  thumb: string | null;
  icon: string | null;
  badge: string | null;
}

export interface MarketItem {
  id: string;
  slug: string;
  name: string;
  names: LocalizedNames;
  assets: MarketAssets;
  ducats: number | null;
}

export type MasteryGroupId =
  | "warframes"
  | "companions"
  | "companionWeapons"
  | "primary"
  | "secondary"
  | "melee"
  | "archwing"
  | "archgun"
  | "archmelee"
  | "other";

export interface MasteryItem {
  id: string;
  name: string;
  names: LocalizedNames;
  description: string | null;
  masteryReq: number;
  group: MasteryGroupId;
  sourceCategory: string;
  typeLabel: string;
  imageUrl: string | null;
  fallbackImageUrl: string | null;
  wikiUrl: string | null;
}

export interface InventoryItem {
  slug: string;
  name: string;
  names?: Partial<LocalizedNames>;
  assets?: Partial<MarketAssets>;
  ducats?: number | null;
  quantity: number;
}

export interface PriceSnapshot {
  slug: string;
  name: string;
  minSellPrice: number | null;
  maxBuyPrice: number | null;
  sellOrderCount: number;
  buyOrderCount: number;
  bestSeller: string | null;
  updatedAt: string;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
}

export interface PriceRequestMeta {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  retryAfterAt: string | null;
  lastErrorStatus: number | null;
  lastErrorMessage: string | null;
}

export interface InventoryRow extends InventoryItem {
  price: PriceSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  ducats: number | null;
}
