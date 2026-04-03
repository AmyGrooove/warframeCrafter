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
}

export interface InventoryItem {
  slug: string;
  name: string;
  names?: Partial<LocalizedNames>;
  assets?: Partial<MarketAssets>;
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
}

export interface InventoryRow extends InventoryItem {
  price: PriceSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}
