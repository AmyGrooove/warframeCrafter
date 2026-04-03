import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { fetchMasteryCatalog } from "./lib/masteryCatalog";
import { fetchPrimeCatalog, fetchPrimePrice } from "./lib/warframeMarket";
import {
  loadFromStorage,
  removeFromStorageByPrefix,
  saveToStorage,
} from "./lib/storage";
import type {
  AppLocale,
  InventoryItem,
  InventoryRow,
  LocalizedNames,
  MasteryGroupId,
  MasteryItem,
  MarketItem,
  PriceSnapshot,
} from "./types";

const INVENTORY_KEY = "wf-prime-tracker:inventory:v1";
const LANGUAGE_KEY = "wf-prime-tracker:language:v1";
const MASTERY_PROGRESS_KEY = "wf-prime-tracker:mastery-progress:v1";
const APP_STORAGE_PREFIX = "wf-prime-tracker:";
const REQUEST_DELAY_MS = 350;
const MASTERY_PAGE_CHUNK_SIZE = 48;

type AppSection = "inventory" | "pricing" | "ducats" | "mastery" | "settings";
type MasteryStatusFilter = "all" | "pending" | "mastered";
type MasteryPrimeFilter = "all" | "prime" | "nonPrime";
type PricingMasteryFilter = "all" | "mastered" | "unmastered";
type PricingSortKey =
  | "quantity"
  | "minSellPrice"
  | "maxBuyPrice"
  | "total"
  | "updatedAt";
type DucatSortKey =
  | "quantity"
  | "ducats"
  | "totalDucats"
  | "minSellPrice"
  | "ducatsPerPlatinum"
  | "updatedAt";

const APP_SECTIONS: Array<{
  id: AppSection;
  label: string;
  description: string;
}> = [
  {
    id: "inventory",
    label: "Инвентарь",
    description: "Добавление предметов и управление личным списком.",
  },
  {
    id: "pricing",
    label: "Стоимость",
    description: "Таблица цен по твоим прайм-предметам.",
  },
  {
    id: "ducats",
    label: "Дукаты",
    description: "Поиск самых выгодных предметов для обмена на дукаты.",
  },
  {
    id: "mastery",
    label: "Освоенные предметы",
    description: "Полный список предметов, которые нужно прокачать для mastery.",
  },
  {
    id: "settings",
    label: "Настройки",
    description: "Параметры интерфейса и отображения.",
  },
];

const MASTERY_GROUPS: Array<{
  id: MasteryGroupId;
  label: string;
}> = [
  { id: "warframes", label: "Варфреймы" },
  { id: "companions", label: "Компаньоны" },
  { id: "companionWeapons", label: "Оружие компаньонов" },
  { id: "primary", label: "Основное оружие" },
  { id: "secondary", label: "Вторичное оружие" },
  { id: "melee", label: "Ближний бой" },
  { id: "archwing", label: "Арчвинги" },
  { id: "archgun", label: "Арч-ганы" },
  { id: "archmelee", label: "Арч-мили" },
  { id: "other", label: "Прочее" },
];

const MASTERY_STATUS_FILTERS: Array<{
  id: MasteryStatusFilter;
  label: string;
}> = [
  { id: "pending", label: "Не освоено" },
  { id: "mastered", label: "Освоено" },
  { id: "all", label: "Любой статус" },
];

const MASTERY_PRIME_FILTERS: Array<{
  id: MasteryPrimeFilter;
  label: string;
}> = [
  { id: "all", label: "Любые" },
  { id: "prime", label: "Prime" },
  { id: "nonPrime", label: "Не Prime" },
];

const PRICING_MASTERY_FILTERS: Array<{
  id: PricingMasteryFilter;
  label: string;
}> = [
  { id: "all", label: "Все" },
  { id: "mastered", label: "Освоено" },
  { id: "unmastered", label: "Не освоено" },
];

function InventorySectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <rect
        x="4.25"
        y="4.25"
        width="15.5"
        height="15.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect
        x="7.25"
        y="7.25"
        width="3.35"
        height="3.35"
        rx="0.8"
        fill="currentColor"
      />
      <rect
        x="13.4"
        y="7.25"
        width="3.35"
        height="3.35"
        rx="0.8"
        fill="currentColor"
        opacity="0.78"
      />
      <rect
        x="7.25"
        y="13.4"
        width="3.35"
        height="3.35"
        rx="0.8"
        fill="currentColor"
        opacity="0.78"
      />
      <rect
        x="13.4"
        y="13.4"
        width="3.35"
        height="3.35"
        rx="0.8"
        fill="currentColor"
      />
    </svg>
  );
}

function PricingSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M5.25 5.25v13.5h13.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m7.75 14.75 3.25-3.75 2.8 2.4 3.95-5.15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.75" cy="14.75" r="1.05" fill="currentColor" />
      <circle cx="11" cy="11" r="1.05" fill="currentColor" />
      <circle cx="13.8" cy="13.4" r="1.05" fill="currentColor" />
      <circle cx="17.75" cy="8.25" r="1.05" fill="currentColor" />
    </svg>
  );
}

function DucatsSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <circle
        cx="12"
        cy="12"
        r="7.25"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 7.3v9.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M14.9 9.25h-3.65a1.7 1.7 0 0 0 0 3.4h1.5a1.7 1.7 0 1 1 0 3.4H9.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MasterySectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M12 4.2 18.4 6.95v4.52c0 3.76-2.22 6.65-6.4 8.33-4.18-1.68-6.4-4.57-6.4-8.33V6.95L12 4.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m9.35 11.85 1.95 1.95 3.45-3.55"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M12 4.35a1.55 1.55 0 0 1 1.47 1.06l.34 1.05c.5.11.97.3 1.42.57l1-.48a1.55 1.55 0 0 1 1.82.29l.66.66a1.55 1.55 0 0 1 .29 1.82l-.48 1c.27.45.46.92.57 1.42l1.05.34A1.55 1.55 0 0 1 19.65 12a1.55 1.55 0 0 1-1.06 1.47l-1.05.34c-.11.5-.3.97-.57 1.42l.48 1a1.55 1.55 0 0 1-.29 1.82l-.66.66a1.55 1.55 0 0 1-1.82.29l-1-.48c-.45.27-.92.46-1.42.57l-.34 1.05A1.55 1.55 0 0 1 12 19.65a1.55 1.55 0 0 1-1.47-1.06l-.34-1.05a5.5 5.5 0 0 1-1.42-.57l-1 .48a1.55 1.55 0 0 1-1.82-.29l-.66-.66a1.55 1.55 0 0 1-.29-1.82l.48-1a5.5 5.5 0 0 1-.57-1.42l-1.05-.34A1.55 1.55 0 0 1 4.35 12a1.55 1.55 0 0 1 1.06-1.47l1.05-.34c.11-.5.3-.97.57-1.42l-.48-1a1.55 1.55 0 0 1 .29-1.82l.66-.66a1.55 1.55 0 0 1 1.82-.29l1 .48c.45-.27.92-.46 1.42-.57l.34-1.05A1.55 1.55 0 0 1 12 4.35Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="2.6"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <path
        d="M18.2 10.05A6.9 6.9 0 0 0 6.9 7.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.3 4.95 6 7.35l2.7.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.8 13.95a6.9 6.9 0 0 0 11.3 2.95"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m16.7 19.05 1.3-2.4-2.7-.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M14.25 4.75h5v5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m10 14 9.25-9.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M19.25 13.25v4a2 2 0 0 1-2 2h-10.5a2 2 0 0 1-2-2V6.75a2 2 0 0 1 2-2h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SoldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M12 5.25v8.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="m8.4 10.95 3.6 3.6 3.6-3.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.25 18.25h11.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M5.75 7.25h12.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M9.35 7.25V6.1a1.35 1.35 0 0 1 1.35-1.35h2.6a1.35 1.35 0 0 1 1.35 1.35v1.15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.1 9.6v6.8a2 2 0 0 0 2 2h3.8a2 2 0 0 0 2-2V9.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.6 11.2v4.4M13.4 11.2v4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MasteryStatusIcon({ status }: { status: boolean | null }) {
  if (status === true) {
    return (
      <span
        className="mastery-status-icon is-mastered"
        aria-label="Освоено"
        title="Освоено"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
          <path
            d="m7.85 12.35 2.55 2.55 5.75-5.8"
            stroke="currentColor"
            strokeWidth="2.15"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === false) {
    return (
      <span
        className="mastery-status-icon is-unmastered"
        aria-label="Не освоено"
        title="Не освоено"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M8.4 8.4 15.6 15.6M15.6 8.4 8.4 15.6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span
      className="mastery-status-icon is-unknown"
      aria-label="Статус освоения неизвестен"
        title="Статус освоения неизвестен"
      >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
        <path
          d="M9 12h6"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function SectionIcon({ section }: { section: AppSection }) {
  if (section === "inventory") {
    return <InventorySectionIcon />;
  }

  if (section === "pricing") {
    return <PricingSectionIcon />;
  }

  if (section === "ducats") {
    return <DucatsSectionIcon />;
  }

  if (section === "mastery") {
    return <MasterySectionIcon />;
  }

  return <SettingsSectionIcon />;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getMarketItemUrl(slug: string) {
  return `https://warframe.market/items/${slug}`;
}

function getMasteryGroupLabel(group: MasteryGroupId) {
  return MASTERY_GROUPS.find((entry) => entry.id === group)?.label ?? group;
}

function formatPlatinum(value: number | null) {
  if (value === null) {
    return "—";
  }

  return (
    <span className="price-value">
      <span>{value.toFixed(0)}</span>
      <img
        className="platinum-icon"
        src="/platinumIcon.webp"
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}

function formatTimestamp(timestamp: string | null) {
  if (!timestamp) {
    return "—";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDucats(value: number | null) {
  if (value === null) {
    return "—";
  }

  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDucatEfficiency(value: number | null) {
  if (value === null) {
    return "—";
  }

  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: value >= 10 ? 0 : 1,
    maximumFractionDigits: value >= 10 ? 1 : 2,
  }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function isPrimeMasteryItem(item: Pick<MasteryItem, "name">) {
  return item.name.toLowerCase().includes("prime");
}

function normalizeLookupText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: "asc" | "desc",
) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return direction === "asc" ? left - right : right - left;
}

function getLocalizedName(
  names: Partial<LocalizedNames> | undefined,
  fallback: string,
  language: AppLocale,
) {
  if (!names) {
    return fallback;
  }

  return names[language] ?? names.en ?? fallback;
}

function shouldUseBlueprintPreview(item: {
  slug: string;
  assets?: {
    badge?: string | null;
    thumb?: string | null;
  };
}) {
  return item.slug.endsWith("_blueprint") && !!item.assets?.badge;
}

function ItemPreview({
  item,
  language,
}: {
  item: {
    slug: string;
    name: string;
    names?: Partial<LocalizedNames>;
    assets?: {
      thumb?: string | null;
      badge?: string | null;
    };
  };
  language: AppLocale;
}) {
  const localizedName = getLocalizedName(item.names, item.name, language);

  if (shouldUseBlueprintPreview(item)) {
    return (
      <div className="item-card-media blueprint-media">
        <div className="blueprint-core" />
        {item.assets?.badge && (
          <img
            className="blueprint-badge"
            src={item.assets.badge}
            alt=""
            aria-hidden="true"
          />
        )}
      </div>
    );
  }

  return (
    <div className="item-card-media">
      {item.assets?.thumb ? (
        <img
          className="item-card-image"
          src={item.assets.thumb}
          alt={localizedName}
        />
      ) : (
        <div className="item-card-fallback" />
      )}
      {item.assets?.badge && (
        <img
          className="item-card-badge"
          src={item.assets.badge}
          alt=""
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function MasteryItemPreview({
  item,
  language,
}: {
  item: MasteryItem;
  language: AppLocale;
}) {
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(
    item.imageUrl ?? item.fallbackImageUrl,
  );
  const localizedName = getLocalizedName(item.names, item.name, language);

  useEffect(() => {
    setCurrentImageUrl(item.imageUrl ?? item.fallbackImageUrl);
  }, [item.fallbackImageUrl, item.id, item.imageUrl]);

  return (
    <div className="item-card-media mastery-media">
      {currentImageUrl ? (
        <img
          className="item-card-image mastery-card-image"
          src={currentImageUrl}
          alt={localizedName}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            if (currentImageUrl !== item.fallbackImageUrl && item.fallbackImageUrl) {
              setCurrentImageUrl(item.fallbackImageUrl);
              return;
            }

            setCurrentImageUrl(null);
          }}
        />
      ) : (
        <div className="item-card-fallback mastery-card-fallback" />
      )}
    </div>
  );
}

function ItemTablePreview({
  item,
  language,
}: {
  item: {
    slug: string;
    name: string;
    names?: Partial<LocalizedNames>;
    assets?: {
      thumb?: string | null;
      badge?: string | null;
    };
  };
  language: AppLocale;
}) {
  const localizedName = getLocalizedName(item.names, item.name, language);

  if (shouldUseBlueprintPreview(item)) {
    return (
      <div className="item-thumb item-thumb-blueprint">
        <div className="item-thumb-blueprint-core" />
        {item.assets?.badge && (
          <img
            className="item-thumb-blueprint-badge"
            src={item.assets.badge}
            alt=""
            aria-hidden="true"
          />
        )}
      </div>
    );
  }

  return (
    <div className="item-thumb">
      {item.assets?.thumb ? (
        <img
          className="item-thumb-image"
          src={item.assets.thumb}
          alt={localizedName}
        />
      ) : (
        <div className="item-thumb-fallback" />
      )}
      {item.assets?.badge && (
        <img
          className="item-thumb-badge"
          src={item.assets.badge}
          alt=""
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function mergeRows(
  inventory: InventoryItem[],
  catalog: MarketItem[],
  priceMap: Record<string, PriceSnapshot>,
  loadingSlugs: Set<string>,
  errors: Record<string, string | null>,
): InventoryRow[] {
  const catalogMap = new Map(catalog.map((item) => [item.slug, item]));

  return inventory.map((item) => {
    const catalogItem = catalogMap.get(item.slug);
    const price = priceMap[item.slug] ?? null;
    const isLoading = loadingSlugs.has(item.slug);
    const error = errors[item.slug] ?? null;

    return {
      ...item,
      name: item.name || catalogItem?.name || item.slug,
      names:
        item.names || catalogItem?.names
          ? {
              ...(catalogItem?.names ?? {}),
              ...(item.names ?? {}),
            }
          : undefined,
      assets:
        item.assets || catalogItem?.assets
          ? {
              ...(catalogItem?.assets ?? {}),
              ...(item.assets ?? {}),
            }
          : undefined,
      ducats: item.ducats ?? catalogItem?.ducats ?? null,
      price,
      status: isLoading ? "loading" : error ? "error" : price ? "ready" : "idle",
      error,
    };
  });
}

export default function App() {
  const [catalog, setCatalog] = useState<MarketItem[]>([]);
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [inventory, setInventory] = useState<InventoryItem[]>(() =>
    loadFromStorage<InventoryItem[]>(INVENTORY_KEY, []),
  );
  const [language, setLanguage] = useState<AppLocale>(() =>
    loadFromStorage<AppLocale>(LANGUAGE_KEY, "ru"),
  );
  const [activeSection, setActiveSection] = useState<AppSection>("inventory");
  const [priceMap, setPriceMap] = useState<Record<string, PriceSnapshot>>({});
  const [loadingSlugs, setLoadingSlugs] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [isBulkRefreshing, setIsBulkRefreshing] = useState(false);
  const [masteryCatalog, setMasteryCatalog] = useState<MasteryItem[]>([]);
  const [masteryCatalogState, setMasteryCatalogState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [masteryCatalogError, setMasteryCatalogError] = useState<string | null>(
    null,
  );
  const [masterySearch, setMasterySearch] = useState("");
  const [masteryGroup, setMasteryGroup] = useState<MasteryGroupId>("warframes");
  const [masteryStatusFilter, setMasteryStatusFilter] =
    useState<MasteryStatusFilter>("pending");
  const [masteryPrimeFilter, setMasteryPrimeFilter] =
    useState<MasteryPrimeFilter>("all");
  const [masteryProgress, setMasteryProgress] = useState<Record<string, boolean>>(
    () => loadFromStorage<Record<string, boolean>>(MASTERY_PROGRESS_KEY, {}),
  );
  const [visibleMasteryCount, setVisibleMasteryCount] = useState(
    MASTERY_PAGE_CHUNK_SIZE,
  );
  const [inventoryMasteryFilter, setInventoryMasteryFilter] =
    useState<PricingMasteryFilter>("all");
  const [pricingMasteryFilter, setPricingMasteryFilter] =
    useState<PricingMasteryFilter>("all");
  const [ducatsMasteryFilter, setDucatsMasteryFilter] =
    useState<PricingMasteryFilter>("all");
  const [pricingSort, setPricingSort] = useState<{
    key: PricingSortKey;
    direction: "asc" | "desc";
  } | null>(null);
  const [ducatSort, setDucatSort] = useState<{
    key: DucatSortKey;
    direction: "asc" | "desc";
  }>({
    key: "ducatsPerPlatinum",
    direction: "desc",
  });
  const masteryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const deferredMasterySearch = useDeferredValue(
    masterySearch.trim().toLowerCase(),
  );

  useEffect(() => {
    saveToStorage(INVENTORY_KEY, inventory);
  }, [inventory]);

  useEffect(() => {
    saveToStorage(LANGUAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    saveToStorage(MASTERY_PROGRESS_KEY, masteryProgress);
  }, [masteryProgress]);

  useEffect(() => {
    async function loadCatalog() {
      try {
        setCatalogState("loading");
        const items = await fetchPrimeCatalog();
        setCatalog(items);
        setCatalogState("ready");
        setCatalogError(null);
      } catch (error) {
        setCatalogState("error");
        setCatalogError(
          error instanceof Error ? error.message : "Не удалось загрузить каталог",
        );
      }
    }

    void loadCatalog();
  }, []);

  useEffect(() => {
    if (catalog.length === 0) {
      return;
    }

    setInventory((current) =>
      current.map((item) => {
        const catalogItem = catalog.find((entry) => entry.slug === item.slug);

        if (!catalogItem) {
          return item;
        }

        return {
          ...item,
          name: catalogItem.name,
          names: {
            ...catalogItem.names,
            ...(item.names ?? {}),
          },
          assets: {
            ...catalogItem.assets,
            ...(item.assets ?? {}),
          },
          ducats: item.ducats ?? catalogItem.ducats,
        };
      }),
    );
  }, [catalog]);

  useEffect(() => {
    if (
      (activeSection !== "mastery" &&
        activeSection !== "pricing" &&
        activeSection !== "ducats" &&
        activeSection !== "inventory") ||
      masteryCatalogState !== "idle"
    ) {
      return;
    }

    async function loadMasteryItems() {
      try {
        setMasteryCatalogState("loading");
        const items = await fetchMasteryCatalog();

        setMasteryCatalog(items);
        setMasteryCatalogState("ready");
        setMasteryCatalogError(null);
      } catch (error) {
        setMasteryCatalogState("error");
        setMasteryCatalogError(
          error instanceof Error
            ? error.message
            : "Не удалось загрузить список mastery-предметов",
        );
      }
    }

    void loadMasteryItems();
  }, [activeSection, masteryCatalogState]);

  useEffect(() => {
    setVisibleMasteryCount(MASTERY_PAGE_CHUNK_SIZE);
  }, [deferredMasterySearch, masteryGroup, masteryPrimeFilter, masteryStatusFilter]);

  async function refreshItem(item: Pick<InventoryItem, "slug" | "name">, force = false) {
    setLoadingSlugs((current) => new Set(current).add(item.slug));
    setErrors((current) => ({ ...current, [item.slug]: null }));

    try {
      const snapshot = await fetchPrimePrice(item, { force });
      setPriceMap((current) => ({ ...current, [item.slug]: snapshot }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [item.slug]:
          error instanceof Error ? error.message : "Не удалось получить цену",
      }));
    } finally {
      setLoadingSlugs((current) => {
        const next = new Set(current);
        next.delete(item.slug);
        return next;
      });
    }
  }

  useEffect(() => {
    if (inventory.length === 0) {
      return;
    }

    const missingPrices = inventory.filter((item) => !priceMap[item.slug]);

    if (missingPrices.length === 0) {
      return;
    }

    let cancelled = false;

    async function hydrateMissingPrices() {
      for (const item of missingPrices) {
        if (cancelled) {
          return;
        }

        await refreshItem(item);
        await wait(REQUEST_DELAY_MS);
      }
    }

    void hydrateMissingPrices();

    return () => {
      cancelled = true;
    };
  }, [inventory, priceMap]);

  const suggestions = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (normalizedSearch.length < 2) {
      return [];
    }

    const existing = new Set(inventory.map((item) => item.slug));

    return catalog
      .filter((item) => {
        if (existing.has(item.slug)) {
          return false;
        }

        const localizedName = getLocalizedName(item.names, item.name, language);
        const englishName = item.names.en;
        const russianName = item.names.ru ?? "";

        return (
          localizedName.toLowerCase().includes(normalizedSearch) ||
          englishName.toLowerCase().includes(normalizedSearch) ||
          russianName.toLowerCase().includes(normalizedSearch)
        );
      })
      .sort((left, right) =>
        getLocalizedName(left.names, left.name, language).localeCompare(
          getLocalizedName(right.names, right.name, language),
          language,
        ),
      )
      .slice(0, 6);
  }, [catalog, inventory, language, search]);

  const rows = useMemo(
    () => mergeRows(inventory, catalog, priceMap, loadingSlugs, errors),
    [catalog, inventory, priceMap, loadingSlugs, errors],
  );
  const activeSectionMeta =
    APP_SECTIONS.find((section) => section.id === activeSection) ?? APP_SECTIONS[0];

  const masteryTotals = useMemo(() => {
    const mastered = masteryCatalog.reduce(
      (count, item) => count + (masteryProgress[item.id] ? 1 : 0),
      0,
    );
    const total = masteryCatalog.length;

    return {
      total,
      mastered,
      remaining: Math.max(total - mastered, 0),
      completionRate: total > 0 ? mastered / total : 0,
    };
  }, [masteryCatalog, masteryProgress]);

  const masteryGroupStats = useMemo(() => {
    const stats = Object.fromEntries(
      MASTERY_GROUPS.map((group) => [group.id, { total: 0, mastered: 0 }]),
    ) as Record<MasteryGroupId, { total: number; mastered: number }>;

    for (const item of masteryCatalog) {
      stats[item.group].total += 1;

      if (masteryProgress[item.id]) {
        stats[item.group].mastered += 1;
      }
    }

    return stats;
  }, [masteryCatalog, masteryProgress]);

  const pricingMasteryLookup = useMemo(() => {
    return masteryCatalog
      .filter((item) => isPrimeMasteryItem(item))
      .map((item) => ({
        id: item.id,
        normalizedName: normalizeLookupText(item.name),
      }))
      .sort((left, right) => right.normalizedName.length - left.normalizedName.length);
  }, [masteryCatalog]);

  const rowsWithMastery = useMemo(() => {
    return rows.map((row) => {
      const normalizedRowName = normalizeLookupText(row.name);
      const masteryMatch = pricingMasteryLookup.find(
        (item) =>
          normalizedRowName === item.normalizedName ||
          normalizedRowName.startsWith(`${item.normalizedName} `),
      );
      const masteryStatus = masteryMatch ? !!masteryProgress[masteryMatch.id] : null;

      return {
        row,
        masteryStatus,
        total:
          row.price?.minSellPrice !== null && row.price
            ? row.price.minSellPrice * row.quantity
            : null,
      };
    });
  }, [masteryProgress, pricingMasteryLookup, rows]);

  const inventoryRows = useMemo(() => {
    return rowsWithMastery.filter((entry) => {
      if (inventoryMasteryFilter === "all") {
        return true;
      }

      if (entry.masteryStatus === null) {
        return false;
      }

      if (inventoryMasteryFilter === "mastered") {
        return entry.masteryStatus;
      }

      return !entry.masteryStatus;
    });
  }, [inventoryMasteryFilter, rowsWithMastery]);

  const pricingRows = useMemo(() => {
    const filteredRows = rowsWithMastery.filter((entry) => {
      if (pricingMasteryFilter === "all") {
        return true;
      }

      if (entry.masteryStatus === null) {
        return false;
      }

      if (pricingMasteryFilter === "mastered") {
        return entry.masteryStatus;
      }

      return !entry.masteryStatus;
    });

    if (!pricingSort) {
      return filteredRows;
    }

    return [...filteredRows].sort((left, right) => {
      switch (pricingSort.key) {
        case "quantity":
          return pricingSort.direction === "asc"
            ? left.row.quantity - right.row.quantity
            : right.row.quantity - left.row.quantity;
        case "minSellPrice":
          return compareNullableNumbers(
            left.row.price?.minSellPrice ?? null,
            right.row.price?.minSellPrice ?? null,
            pricingSort.direction,
          );
        case "maxBuyPrice":
          return compareNullableNumbers(
            left.row.price?.maxBuyPrice ?? null,
            right.row.price?.maxBuyPrice ?? null,
            pricingSort.direction,
          );
        case "total":
          return compareNullableNumbers(left.total, right.total, pricingSort.direction);
        case "updatedAt":
          return compareNullableNumbers(
            left.row.price ? new Date(left.row.price.updatedAt).getTime() : null,
            right.row.price ? new Date(right.row.price.updatedAt).getTime() : null,
            pricingSort.direction,
          );
        default:
          return 0;
      }
    });
  }, [pricingMasteryFilter, pricingSort, rowsWithMastery]);

  const pricingTotals = useMemo(() => {
    return pricingRows.reduce(
      (summary, row) => {
        summary.uniqueItems += 1;
        summary.totalQuantity += row.row.quantity;

        if (row.row.price && row.row.price.minSellPrice !== null) {
          summary.totalSellValue += row.row.price.minSellPrice * row.row.quantity;
        }

        if (row.row.price && row.row.price.maxBuyPrice !== null) {
          summary.totalBuyValue += row.row.price.maxBuyPrice * row.row.quantity;
        }

        return summary;
      },
      {
        uniqueItems: 0,
        totalQuantity: 0,
        totalSellValue: 0,
        totalBuyValue: 0,
      },
    );
  }, [pricingRows]);

  const ducatRows = useMemo(() => {
    const filteredRows = rowsWithMastery
      .filter((entry) => (entry.row.ducats ?? 0) > 0)
      .filter((entry) => {
        if (ducatsMasteryFilter === "all") {
          return true;
        }

        if (entry.masteryStatus === null) {
          return false;
        }

        if (ducatsMasteryFilter === "mastered") {
          return entry.masteryStatus;
        }

        return !entry.masteryStatus;
      })
      .map((entry) => {
        const ducats = entry.row.ducats ?? 0;
        const minSellPrice = entry.row.price?.minSellPrice ?? null;
        const ducatsPerPlatinum =
          minSellPrice !== null && minSellPrice > 0 ? ducats / minSellPrice : null;

        return {
          ...entry,
          ducats,
          totalDucats: ducats * entry.row.quantity,
          ducatsPerPlatinum,
        };
      });

    return [...filteredRows].sort((left, right) => {
      switch (ducatSort.key) {
        case "quantity":
          return ducatSort.direction === "asc"
            ? left.row.quantity - right.row.quantity
            : right.row.quantity - left.row.quantity;
        case "ducats":
          return compareNullableNumbers(left.ducats, right.ducats, ducatSort.direction);
        case "totalDucats":
          return compareNullableNumbers(
            left.totalDucats,
            right.totalDucats,
            ducatSort.direction,
          );
        case "minSellPrice":
          return compareNullableNumbers(
            left.row.price?.minSellPrice ?? null,
            right.row.price?.minSellPrice ?? null,
            ducatSort.direction,
          );
        case "updatedAt":
          return compareNullableNumbers(
            left.row.price ? new Date(left.row.price.updatedAt).getTime() : null,
            right.row.price ? new Date(right.row.price.updatedAt).getTime() : null,
            ducatSort.direction,
          );
        case "ducatsPerPlatinum": {
          const efficiencyComparison = compareNullableNumbers(
            left.ducatsPerPlatinum,
            right.ducatsPerPlatinum,
            ducatSort.direction,
          );

          if (efficiencyComparison !== 0) {
            return efficiencyComparison;
          }

          const ducatComparison = compareNullableNumbers(
            left.ducats,
            right.ducats,
            "desc",
          );

          if (ducatComparison !== 0) {
            return ducatComparison;
          }

          const priceComparison = compareNullableNumbers(
            left.row.price?.minSellPrice ?? null,
            right.row.price?.minSellPrice ?? null,
            "asc",
          );

          if (priceComparison !== 0) {
            return priceComparison;
          }

          return getLocalizedName(left.row.names, left.row.name, language).localeCompare(
            getLocalizedName(right.row.names, right.row.name, language),
            language,
            { numeric: true },
          );
        }
        default:
          return 0;
      }
    });
  }, [ducatSort, ducatsMasteryFilter, language, rowsWithMastery]);

  const ducatTotals = useMemo(() => {
    return ducatRows.reduce(
      (summary, row) => {
        summary.uniqueItems += 1;
        summary.totalQuantity += row.row.quantity;
        summary.totalDucats += row.totalDucats;

        if (row.ducatsPerPlatinum !== null) {
          summary.bestEfficiency =
            summary.bestEfficiency === null
              ? row.ducatsPerPlatinum
              : Math.max(summary.bestEfficiency, row.ducatsPerPlatinum);
        }

        return summary;
      },
      {
        uniqueItems: 0,
        totalQuantity: 0,
        totalDucats: 0,
        bestEfficiency: null as number | null,
      },
    );
  }, [ducatRows]);

  const filteredMasteryItems = useMemo(() => {
    return masteryCatalog
      .filter((item) => {
        if (item.group !== masteryGroup) {
          return false;
        }

        const isMastered = !!masteryProgress[item.id];
        const isPrime = isPrimeMasteryItem(item);

        if (masteryStatusFilter === "pending" && isMastered) {
          return false;
        }

        if (masteryStatusFilter === "mastered" && !isMastered) {
          return false;
        }

        if (masteryPrimeFilter === "prime" && !isPrime) {
          return false;
        }

        if (masteryPrimeFilter === "nonPrime" && isPrime) {
          return false;
        }

        if (deferredMasterySearch.length === 0) {
          return true;
        }

        const searchTarget = [
          item.name,
          item.names.ru ?? "",
          item.typeLabel,
          item.sourceCategory,
          getMasteryGroupLabel(item.group),
        ]
          .join(" ")
          .toLowerCase();

        return searchTarget.includes(deferredMasterySearch);
      })
      .sort((left, right) => {
        const leftMastered = masteryProgress[left.id] ? 1 : 0;
        const rightMastered = masteryProgress[right.id] ? 1 : 0;

        if (leftMastered !== rightMastered) {
          return leftMastered - rightMastered;
        }

        return getLocalizedName(left.names, left.name, language).localeCompare(
          getLocalizedName(right.names, right.name, language),
          language,
          { numeric: true },
        );
      });
  }, [
    deferredMasterySearch,
    language,
    masteryCatalog,
    masteryGroup,
    masteryPrimeFilter,
    masteryProgress,
    masteryStatusFilter,
  ]);

  const visibleMasteryItems = useMemo(
    () => filteredMasteryItems.slice(0, visibleMasteryCount),
    [filteredMasteryItems, visibleMasteryCount],
  );
  const hasMoreMasteryItems = visibleMasteryItems.length < filteredMasteryItems.length;

  useEffect(() => {
    const target = masteryLoadMoreRef.current;

    if (
      activeSection !== "mastery" ||
      !target ||
      !hasMoreMasteryItems ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleMasteryCount((current) =>
            Math.min(current + MASTERY_PAGE_CHUNK_SIZE, filteredMasteryItems.length),
          );
        }
      },
      {
        rootMargin: "240px 0px",
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [activeSection, filteredMasteryItems.length, hasMoreMasteryItems]);

  function addItem(item: MarketItem) {
    setInventory((current) => {
      if (current.some((entry) => entry.slug === item.slug)) {
        return current;
      }

      return [
        {
          slug: item.slug,
          name: item.name,
          names: item.names,
          assets: item.assets,
          ducats: item.ducats,
          quantity: 1,
        },
        ...current,
      ];
    });
  }

  function changeQuantity(slug: string, quantity: number) {
    const safeQuantity = Number.isFinite(quantity) ? Math.max(1, quantity) : 1;

    setInventory((current) =>
      current.map((item) =>
        item.slug === slug ? { ...item, quantity: safeQuantity } : item,
      ),
    );
  }

  function removeItem(slug: string) {
    setInventory((current) => current.filter((item) => item.slug !== slug));
    setErrors((current) => {
      const next = { ...current };
      delete next[slug];
      return next;
    });
    setPriceMap((current) => {
      const next = { ...current };
      delete next[slug];
      return next;
    });
  }

  function sellOneItem(slug: string) {
    const target = inventory.find((item) => item.slug === slug);

    if (!target) {
      return;
    }

    if (target.quantity <= 1) {
      removeItem(slug);
      return;
    }

    changeQuantity(slug, target.quantity - 1);
  }

  function toggleMastered(itemId: string) {
    setMasteryProgress((current) => {
      const next = { ...current };

      if (next[itemId]) {
        delete next[itemId];
      } else {
        next[itemId] = true;
      }

      return next;
    });
  }

  function togglePricingSort(key: PricingSortKey) {
    setPricingSort((current) => {
      if (current?.key === key) {
        if (current.direction === "asc") {
          return null;
        }

        return {
          key,
          direction: "asc",
        };
      }

      return {
        key,
        direction: "desc",
      };
    });
  }

  function getPricingSortMarker(key: PricingSortKey) {
    if (pricingSort?.key !== key) {
      return "";
    }

    return pricingSort.direction === "desc" ? " v" : " ^";
  }

  function toggleDucatSort(key: DucatSortKey) {
    setDucatSort((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === "desc" ? "asc" : "desc",
        };
      }

      return {
        key,
        direction: key === "minSellPrice" ? "asc" : "desc",
      };
    });
  }

  function getDucatSortMarker(key: DucatSortKey) {
    if (ducatSort.key !== key) {
      return "";
    }

    return ducatSort.direction === "desc" ? " v" : " ^";
  }

  function clearAllData() {
    const confirmed = window.confirm(
      "Очистить весь инвентарь, прогресс освоения, фильтры, настройки языка и локальные кеши приложения?",
    );

    if (!confirmed) {
      return;
    }

    removeFromStorageByPrefix(APP_STORAGE_PREFIX);
    setInventory([]);
    setSearch("");
    setLanguage("ru");
    setPriceMap({});
    setLoadingSlugs(new Set());
    setErrors({});
    setIsBulkRefreshing(false);
    setInventoryMasteryFilter("all");
    setPricingMasteryFilter("all");
    setDucatsMasteryFilter("all");
    setPricingSort(null);
    setDucatSort({
      key: "ducatsPerPlatinum",
      direction: "desc",
    });
    setMasteryProgress({});
    setMasterySearch("");
    setMasteryGroup("warframes");
    setMasteryStatusFilter("pending");
    setMasteryPrimeFilter("all");
    setVisibleMasteryCount(MASTERY_PAGE_CHUNK_SIZE);
  }

  async function refreshAll(force = false) {
    if (inventory.length === 0) {
      return;
    }

    setIsBulkRefreshing(true);

    try {
      for (const item of inventory) {
        await refreshItem(item, force);
        await wait(REQUEST_DELAY_MS);
      }
    } finally {
      setIsBulkRefreshing(false);
    }
  }

  return (
    <div className="app-shell">
      <main className="page app-layout">
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-kicker">Разделы</span>
            <strong>Prime Tracker</strong>
          </div>

          <nav className="sidebar-nav" aria-label="Разделы приложения">
            {APP_SECTIONS.map((section) => (
              <button
                key={section.id}
                className={`sidebar-tab${activeSection === section.id ? " is-active" : ""}`}
                type="button"
                aria-label={section.label}
                title={section.label}
                onClick={() => setActiveSection(section.id)}
              >
                <SectionIcon section={section.id} />
              </button>
            ))}
          </nav>
        </aside>

        <div className="app-content">
          <header className="topbar">
            <div className="topbar-copy">
              <h1>{activeSectionMeta.label}</h1>
              <p>{activeSectionMeta.description}</p>
            </div>

            <div className="topbar-actions">
              {activeSection === "inventory" && (
                <div className="topbar-pill">{rows.length} предметов</div>
              )}
              {activeSection === "pricing" && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void refreshAll(true)}
                  disabled={isBulkRefreshing || inventory.length === 0}
                >
                  {isBulkRefreshing ? "Обновляю цены..." : "Обновить все цены"}
                </button>
              )}
              {activeSection === "ducats" && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void refreshAll(true)}
                  disabled={isBulkRefreshing || inventory.length === 0}
                >
                  {isBulkRefreshing ? "Обновляю цены..." : "Обновить все цены"}
                </button>
              )}
              {activeSection === "mastery" && masteryCatalogState === "ready" && (
                <div className="topbar-pill">
                  {masteryTotals.mastered}/{masteryTotals.total} освоено
                </div>
              )}
            </div>
          </header>

          {activeSection === "inventory" ? (
            <div className="inventory-page">
              <section className="panel search-panel">
                <div className="section-heading">
                  <div>
                    <h2>Добавить предмет</h2>
                    <p>Нажми на карточку, чтобы добавить её в свой инвентарь.</p>
                  </div>
                </div>

                <div className="search-block">
                  <input
                    id="item-search"
                    className="search-input"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Revenant Prime Systems Blueprint"
                    autoComplete="off"
                  />

                  {catalogState === "loading" && (
                    <p className="state-message">Загружаю каталог...</p>
                  )}
                  {catalogState === "error" && (
                    <p className="state-message error">
                      {catalogError ?? "Не удалось загрузить каталог."}
                    </p>
                  )}
                  {search.trim().length >= 2 &&
                    suggestions.length === 0 &&
                    catalogState === "ready" && (
                      <p className="state-message">Ничего не найдено.</p>
                    )}
                </div>

                {suggestions.length > 0 && (
                  <div className="item-grid search-suggestions-grid">
                    {suggestions.map((item) => (
                      <button
                        key={item.slug}
                        className="item-card item-card-button"
                        type="button"
                        onClick={() => addItem(item)}
                      >
                        <ItemPreview item={item} language={language} />
                        <div className="item-card-body">
                          <strong>
                            {getLocalizedName(item.names, item.name, language)}
                          </strong>
                          <span>{item.slug}</span>
                        </div>
                        <span className="item-card-action">Добавить</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="panel collection-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <div>
                      <h2>Мой инвентарь</h2>
                      <p>
                        {inventoryRows.length === 0
                          ? "Пока пусто"
                          : inventoryMasteryFilter === "all"
                            ? `${inventoryRows.length} позиций в коллекции`
                            : `${inventoryRows.length} из ${rows.length} позиций`}
                      </p>
                    </div>
                  </div>
                  <span className="table-note">
                    Управляй количеством здесь, цены смотри во вкладке стоимости.
                  </span>
                </div>

                <div className="pricing-toolbar">
                  <div className="filter-row pricing-filter-row" aria-label="Фильтр инвентаря по освоению">
                    {PRICING_MASTERY_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${inventoryMasteryFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setInventoryMasteryFilter(filter.id)}
                        disabled={
                          filter.id !== "all" &&
                          masteryCatalogState !== "ready"
                        }
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {masteryCatalogState === "loading" && (
                    <span className="table-note table-note-inline">
                      Загружаю статусы освоения...
                    </span>
                  )}
                  {masteryCatalogState === "error" && (
                    <span className="table-note table-note-inline">
                      Статусы освоения недоступны.
                    </span>
                  )}
                </div>

                {inventoryRows.length === 0 ? (
                  <div className="empty-state">
                    <h3>{rows.length === 0 ? "Инвентарь пуст" : "Ничего не найдено"}</h3>
                    <p>
                      {rows.length === 0
                        ? "Добавь предметы через поиск выше."
                        : "Фильтр по освоению не оставил ни одной позиции."}
                    </p>
                  </div>
                ) : (
                  <div className="item-grid owned-grid">
                    {inventoryRows.map(({ row }) => (
                      <article key={row.slug} className="item-card owned-card">
                        <ItemPreview item={row} language={language} />

                        <div className="item-card-body">
                          <strong>
                            {getLocalizedName(row.names, row.name, language)}
                          </strong>
                          <span>{row.slug}</span>
                        </div>

                        <div className="owned-card-footer">
                          <div className="owned-card-meta">
                            <label className="card-quantity" aria-label="Количество предметов">
                              <input
                                className="quantity-input"
                                type="number"
                                min={1}
                                step={1}
                                value={row.quantity}
                                onChange={(event) =>
                                  changeQuantity(
                                    row.slug,
                                    Number.parseInt(event.target.value, 10),
                                  )
                                }
                              />
                            </label>
                            <button
                              className="danger-button icon-button inventory-delete-button"
                              type="button"
                              onClick={() => removeItem(row.slug)}
                              aria-label="Удалить предмет"
                              title="Удалить предмет"
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : activeSection === "pricing" ? (
            <>
              <section className="summary-grid">
                <article className="summary-card">
                  <span>Позиции</span>
                  <strong>{pricingTotals.uniqueItems}</strong>
                </article>
                <article className="summary-card">
                  <span>Штук</span>
                  <strong>{pricingTotals.totalQuantity}</strong>
                </article>
                <article className="summary-card">
                  <span>Мин. продажа</span>
                  <strong>{formatPlatinum(pricingTotals.totalSellValue)}</strong>
                </article>
                <article className="summary-card">
                  <span>Макс. покупка</span>
                  <strong>{formatPlatinum(pricingTotals.totalBuyValue)}</strong>
                </article>
              </section>

              <section className="panel pricing-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>Стоимость прайм предметов</h2>
                    <p>
                      {pricingRows.length === 0
                        ? "Пусто"
                        : `${pricingRows.length} позиций`}
                    </p>
                  </div>
                  <span className="table-note">
                    Продажа = минимальная цена у продавцов, покупка = лучшая ставка покупателя
                  </span>
                </div>

                <div className="pricing-toolbar">
                  <div className="filter-row pricing-filter-row" aria-label="Фильтр по освоению">
                    {PRICING_MASTERY_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${pricingMasteryFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setPricingMasteryFilter(filter.id)}
                        disabled={
                          filter.id !== "all" &&
                          masteryCatalogState !== "ready"
                        }
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {masteryCatalogState === "loading" && (
                    <span className="table-note table-note-inline">
                      Загружаю статусы освоения...
                    </span>
                  )}
                  {masteryCatalogState === "error" && (
                    <span className="table-note table-note-inline">
                      Статусы освоения недоступны.
                    </span>
                  )}
                </div>

                {pricingRows.length === 0 ? (
                  <div className="empty-state">
                    <h3>Нет предметов для оценки</h3>
                    <p>
                      {rows.length === 0
                        ? "Сначала добавь их во вкладке инвентаря."
                        : "Фильтр не оставил ни одной позиции."}
                    </p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="inventory-table">
                      <thead>
                        <tr>
                          <th>Предмет</th>
                          <th>Освоение</th>
                          <th>
                            <button
                              className={`table-sort-button${pricingSort?.key === "quantity" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => togglePricingSort("quantity")}
                            >
                              Кол-во{getPricingSortMarker("quantity")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${pricingSort?.key === "minSellPrice" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => togglePricingSort("minSellPrice")}
                            >
                              Мин. продажа{getPricingSortMarker("minSellPrice")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${pricingSort?.key === "maxBuyPrice" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => togglePricingSort("maxBuyPrice")}
                            >
                              Макс. покупка{getPricingSortMarker("maxBuyPrice")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${pricingSort?.key === "total" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => togglePricingSort("total")}
                            >
                              Сумма{getPricingSortMarker("total")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${pricingSort?.key === "updatedAt" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => togglePricingSort("updatedAt")}
                            >
                              Обновлено{getPricingSortMarker("updatedAt")}
                            </button>
                          </th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {pricingRows.map(({ row, total, masteryStatus }) => {

                          return (
                            <tr key={row.slug}>
                              <td>
                                <div className="item-name-row">
                                  <ItemTablePreview item={row} language={language} />
                                  <div className="item-name-cell">
                                    <strong>
                                      {getLocalizedName(row.names, row.name, language)}
                                    </strong>
                                    <span>{row.slug}</span>
                                    {row.error && (
                                      <span className="inline-error">{row.error}</span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td>
                                <MasteryStatusIcon status={masteryStatus} />
                              </td>
                              <td>{row.quantity}</td>
                              <td>{formatPlatinum(row.price?.minSellPrice ?? null)}</td>
                              <td>{formatPlatinum(row.price?.maxBuyPrice ?? null)}</td>
                              <td>{formatPlatinum(total)}</td>
                              <td>{formatTimestamp(row.price?.updatedAt ?? null)}</td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    className="ghost-button icon-button sold-icon-button"
                                    type="button"
                                    onClick={() => sellOneItem(row.slug)}
                                    aria-label="Отметить одну штуку как проданную"
                                    title="Продано: убрать 1 штуку"
                                  >
                                    <SoldIcon />
                                  </button>
                                  <button
                                    className={`ghost-button icon-button${row.status === "loading" ? " is-spinning" : ""}`}
                                    type="button"
                                    onClick={() => void refreshItem(row, true)}
                                    disabled={row.status === "loading"}
                                    aria-label="Обновить цену"
                                    title="Обновить цену"
                                  >
                                    <RefreshIcon />
                                  </button>
                                  <a
                                    className="ghost-button icon-button"
                                    href={getMarketItemUrl(row.slug)}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label="Открыть на warframe.market"
                                    title="Открыть на warframe.market"
                                  >
                                    <ExternalLinkIcon />
                                  </a>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : activeSection === "ducats" ? (
            <>
              <section className="summary-grid">
                <article className="summary-card">
                  <span>Позиции</span>
                  <strong>{ducatTotals.uniqueItems}</strong>
                </article>
                <article className="summary-card">
                  <span>Штук</span>
                  <strong>{ducatTotals.totalQuantity}</strong>
                </article>
                <article className="summary-card">
                  <span>Всего дукатов</span>
                  <strong>{formatDucats(ducatTotals.totalDucats)}</strong>
                </article>
                <article className="summary-card">
                  <span>Лучший курс</span>
                  <strong>{formatDucatEfficiency(ducatTotals.bestEfficiency)}</strong>
                </article>
              </section>

              <section className="panel pricing-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>Обмен на дукаты</h2>
                    <p>
                      {ducatRows.length === 0
                        ? "Пусто"
                        : `${ducatRows.length} позиций`}
                    </p>
                  </div>
                  <span className="table-note">
                    Выгодность = дукаты / мин. продажа. Сверху самые выгодные предметы.
                  </span>
                </div>

                <div className="pricing-toolbar">
                  <div className="filter-row pricing-filter-row" aria-label="Фильтр дукатов по освоению">
                    {PRICING_MASTERY_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${ducatsMasteryFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setDucatsMasteryFilter(filter.id)}
                        disabled={
                          filter.id !== "all" &&
                          masteryCatalogState !== "ready"
                        }
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {masteryCatalogState === "loading" && (
                    <span className="table-note table-note-inline">
                      Загружаю статусы освоения...
                    </span>
                  )}
                  {masteryCatalogState === "error" && (
                    <span className="table-note table-note-inline">
                      Статусы освоения недоступны.
                    </span>
                  )}
                </div>

                {ducatRows.length === 0 ? (
                  <div className="empty-state">
                    <h3>Нет предметов для обмена</h3>
                    <p>
                      {rows.length === 0
                        ? "Сначала добавь предметы во вкладке инвентаря."
                        : "Фильтр не оставил ни одной позиции или у предметов нет данных по дукатам."}
                    </p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="inventory-table">
                      <thead>
                        <tr>
                          <th>Предмет</th>
                          <th>Освоение</th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "quantity" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("quantity")}
                            >
                              Кол-во{getDucatSortMarker("quantity")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "ducats" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("ducats")}
                            >
                              Дукаты{getDucatSortMarker("ducats")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "totalDucats" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("totalDucats")}
                            >
                              Всего дукатов{getDucatSortMarker("totalDucats")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "minSellPrice" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("minSellPrice")}
                            >
                              Мин. продажа{getDucatSortMarker("minSellPrice")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "ducatsPerPlatinum" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("ducatsPerPlatinum")}
                            >
                              Дукаты / платину{getDucatSortMarker("ducatsPerPlatinum")}
                            </button>
                          </th>
                          <th>
                            <button
                              className={`table-sort-button${ducatSort.key === "updatedAt" ? " is-active" : ""}`}
                              type="button"
                              onClick={() => toggleDucatSort("updatedAt")}
                            >
                              Обновлено{getDucatSortMarker("updatedAt")}
                            </button>
                          </th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {ducatRows.map(
                          ({
                            row,
                            masteryStatus,
                            ducats,
                            totalDucats,
                            ducatsPerPlatinum,
                          }) => {
                            return (
                              <tr key={row.slug}>
                                <td>
                                  <div className="item-name-row">
                                    <ItemTablePreview item={row} language={language} />
                                    <div className="item-name-cell">
                                      <strong>
                                        {getLocalizedName(row.names, row.name, language)}
                                      </strong>
                                      <span>{row.slug}</span>
                                      {row.error && (
                                        <span className="inline-error">{row.error}</span>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <MasteryStatusIcon status={masteryStatus} />
                                </td>
                                <td>{row.quantity}</td>
                                <td>{formatDucats(ducats)}</td>
                                <td>{formatDucats(totalDucats)}</td>
                                <td>{formatPlatinum(row.price?.minSellPrice ?? null)}</td>
                                <td>{formatDucatEfficiency(ducatsPerPlatinum)}</td>
                                <td>{formatTimestamp(row.price?.updatedAt ?? null)}</td>
                                <td>
                                  <div className="row-actions">
                                    <button
                                      className="ghost-button icon-button sold-icon-button"
                                      type="button"
                                      onClick={() => sellOneItem(row.slug)}
                                      aria-label="Отметить одну штуку как проданную"
                                      title="Продано: убрать 1 штуку"
                                    >
                                      <SoldIcon />
                                    </button>
                                    <button
                                      className={`ghost-button icon-button${row.status === "loading" ? " is-spinning" : ""}`}
                                      type="button"
                                      onClick={() => void refreshItem(row, true)}
                                      disabled={row.status === "loading"}
                                      aria-label="Обновить цену"
                                      title="Обновить цену"
                                    >
                                      <RefreshIcon />
                                    </button>
                                    <a
                                      className="ghost-button icon-button"
                                      href={getMarketItemUrl(row.slug)}
                                      target="_blank"
                                      rel="noreferrer"
                                      aria-label="Открыть на warframe.market"
                                      title="Открыть на warframe.market"
                                    >
                                      <ExternalLinkIcon />
                                    </a>
                                  </div>
                                </td>
                              </tr>
                            );
                          },
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : activeSection === "mastery" ? (
            <>
              <section className="summary-grid">
                <article className="summary-card">
                  <span>Всего</span>
                  <strong>{masteryTotals.total}</strong>
                </article>
                <article className="summary-card">
                  <span>Освоено</span>
                  <strong>{masteryTotals.mastered}</strong>
                </article>
                <article className="summary-card">
                  <span>Осталось</span>
                  <strong>{masteryTotals.remaining}</strong>
                </article>
                <article className="summary-card">
                  <span>Прогресс</span>
                  <strong>{formatPercent(masteryTotals.completionRate)}</strong>
                </article>
              </section>

              <section className="panel mastery-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>Каталог mastery-предметов</h2>
                    <p>
                      Отмечай всё, что уже прокачано. Прогресс сохраняется локально
                      в браузере.
                    </p>
                  </div>
                  <span className="table-note">
                    Сейчас вкладка использует готовый каталог, поэтому названия
                    предметов пока на английском.
                  </span>
                </div>

                <div className="mastery-toolbar">
                  <input
                    className="search-input"
                    value={masterySearch}
                    onChange={(event) => setMasterySearch(event.target.value)}
                    placeholder="Excalibur, Carrier Prime, Catchmoon..."
                    autoComplete="off"
                  />

                  <div className="filter-row" aria-label="Фильтр по статусу освоения">
                    {MASTERY_STATUS_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${masteryStatusFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setMasteryStatusFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>

                  <div className="filter-row" aria-label="Фильтр по Prime">
                    {MASTERY_PRIME_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${masteryPrimeFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setMasteryPrimeFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="filter-row" aria-label="Фильтр по категориям mastery">
                  {MASTERY_GROUPS.map((group) => {
                    const stats = masteryGroupStats[group.id];

                    return (
                      <button
                        key={group.id}
                        className={`filter-chip${masteryGroup === group.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setMasteryGroup(group.id)}
                      >
                        {group.label}
                        <span>
                          {stats.mastered}/{stats.total}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {masteryCatalogState === "loading" || masteryCatalogState === "idle" ? (
                  <div className="empty-state">
                    <h3>Загружаю каталог</h3>
                    <p>Подтягиваю список всех предметов для освоения.</p>
                  </div>
                ) : masteryCatalogState === "error" ? (
                  <div className="empty-state">
                    <h3>Не удалось загрузить каталог</h3>
                    <p>{masteryCatalogError ?? "Попробуй повторить позже."}</p>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => setMasteryCatalogState("idle")}
                    >
                      Повторить загрузку
                    </button>
                  </div>
                ) : filteredMasteryItems.length === 0 ? (
                  <div className="empty-state">
                    <h3>Ничего не найдено</h3>
                    <p>Смени поиск или фильтры по статусу и категории.</p>
                  </div>
                ) : (
                  <>
                    <div className="mastery-results-meta">
                      <span>
                        Показано {visibleMasteryItems.length} из {filteredMasteryItems.length}
                      </span>
                      <span>{getMasteryGroupLabel(masteryGroup)}</span>
                    </div>

                    <div className="item-grid mastery-grid">
                      {visibleMasteryItems.map((item) => {
                        const isMastered = !!masteryProgress[item.id];

                        return (
                          <article
                            key={item.id}
                            className={`item-card mastery-card${isMastered ? " is-mastered" : ""}`}
                          >
                            <MasteryItemPreview item={item} language={language} />

                            <div className="item-card-body mastery-card-body">
                              <strong>
                                {getLocalizedName(item.names, item.name, language)}
                              </strong>
                            </div>

                            <div className="mastery-card-footer">
                              {item.wikiUrl ? (
                                <a
                                  className="ghost-button mastery-wiki-button"
                                  href={item.wikiUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Вики
                                  <ExternalLinkIcon />
                                </a>
                              ) : null}

                              <button
                                className={`mastery-toggle${isMastered ? " is-active" : ""}`}
                                type="button"
                                onClick={() => toggleMastered(item.id)}
                              >
                                {isMastered ? "Освоено" : "Отметить"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>

                    {hasMoreMasteryItems && (
                      <div className="mastery-load-more">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() =>
                            setVisibleMasteryCount((current) =>
                              Math.min(
                                current + MASTERY_PAGE_CHUNK_SIZE,
                                filteredMasteryItems.length,
                              ),
                            )
                          }
                        >
                          Показать еще
                        </button>
                        <div
                          ref={masteryLoadMoreRef}
                          className="mastery-load-sentinel"
                          aria-hidden="true"
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          ) : (
            <section className="panel settings-panel">
              <div className="settings-list">
                <article className="settings-item">
                  <div className="settings-copy">
                    <strong>Язык названий предметов</strong>
                    <p>
                      Переключает отображение названий между русским и английским
                      во всех вкладках.
                    </p>
                  </div>

                  <button
                    className={`language-switch ${language === "en" ? "is-english" : "is-russian"}`}
                    type="button"
                    aria-label="Переключить язык названий"
                    role="switch"
                    aria-checked={language === "en"}
                    onClick={() =>
                      setLanguage((current) => (current === "ru" ? "en" : "ru"))
                    }
                  >
                    <span className="language-switch-thumb" aria-hidden="true" />
                    <span className="language-switch-option">RU</span>
                    <span className="language-switch-option">EN</span>
                  </button>
                </article>

                <article className="settings-item">
                  <div className="settings-copy">
                    <strong>Очистить все данные</strong>
                    <p>
                      Удаляет инвентарь, прогресс освоения, фильтры, язык и локальные
                      кеши приложения.
                    </p>
                  </div>

                  <button
                    className="danger-button"
                    type="button"
                    onClick={clearAllData}
                  >
                    Очистить все
                  </button>
                </article>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
