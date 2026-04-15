import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type FormEvent,
} from "react";
import { fetchMasteryCatalog } from "./lib/masteryCatalog";
import {
  fetchPrimeCatalog,
  fetchPrimePrice,
  isPriceSnapshotStale,
  loadCachedPriceSnapshots,
  PriceFetchError,
} from "./lib/warframeMarket";
import {
  fetchWikiPageData,
  normalizeWikiPageTitle,
  type WikiCraftingIngredient,
  type WikiPageData,
} from "./lib/warframeWiki";
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
  MarketAssets,
  PriceRequestMeta,
  PriceSnapshot,
} from "./types";

const INVENTORY_KEY = "wf-prime-tracker:inventory:v1";
const LANGUAGE_KEY = "wf-prime-tracker:language:v1";
const MARKET_USERNAME_KEY = "wf-prime-tracker:market-username:v1";
const INVENTORY_IMAGE_IMPORT_MODE_KEY =
  "wf-prime-tracker:inventory-image-import-mode:v1";
const MASTERY_PROGRESS_KEY = "wf-prime-tracker:mastery-progress:v1";
const PRICE_REQUEST_META_KEY = "wf-prime-tracker:price-request-meta:v1";
const SALE_MARKS_KEY = "wf-prime-tracker:sale-marks:v1";
const SOLD_HISTORY_KEY = "wf-prime-tracker:sold-history:v1";
const WIKI_PAGE_CACHE_KEY = "wf-prime-tracker:wiki-page-cache:v4";
const WIKI_PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const APP_STORAGE_PREFIX = "wf-prime-tracker:";
const PRICE_QUEUE_CONCURRENCY = 2;
const PRICE_QUEUE_DELAY_MS = 180;
const PRICE_GENERAL_RETRY_MS = 60 * 1000;
const PRICE_ERROR_COOLDOWN_MS = 7 * 60 * 1000;
const SECTION_RENDER_CHUNK_SIZE = 48;
const INVENTORY_IMAGE_IMPORT_DISABLED = true;

type AppSection =
  | "inventory"
  | "statistics"
  | "pricing"
  | "ducats"
  | "mastery"
  | "settings";
type MasteryStatusFilter = "all" | "pending" | "mastered";
type MasteryGroupFilterId = "all" | MasteryGroupId;
type PricingMasteryFilter = "all" | "mastered" | "unmastered";
type SaleRecordType = "item" | "set";
type SaleRecordSource = "auto" | "manual";
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
type InventorySortDirection = "asc" | "desc";
type InventorySortState = InventorySortDirection | null;
type InventoryImageImportMode = "append" | "replace";

function isInventoryImageImportMode(value: unknown): value is InventoryImageImportMode {
  return value === "append" || value === "replace";
}

const APP_SECTIONS: Array<{
  id: AppSection;
  label: string;
  description: string;
  disabled?: boolean;
}> = [
  {
    id: "inventory",
    label: "Инвентарь",
    description: "Добавление предметов и управление личным списком.",
  },
  {
    id: "statistics",
    label: "Статистика",
    description: "История всех проданных вещей и ручные записи продаж.",
    disabled: true,
  },
  {
    id: "pricing",
    label: "Стоимость",
    description: "Таблица цен по прайм-предметам и комплектам.",
  },
  {
    id: "ducats",
    label: "Дукаты",
    description: "Поиск самых выгодных предметов для обмена на дукаты.",
  },
  {
    id: "mastery",
    label: "Освоенные предметы",
    description: "Каталог Prime-предметов, которые нужно прокачать для mastery.",
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

const MASTERY_GROUP_FILTERS: Array<{
  id: MasteryGroupFilterId;
  label: string;
}> = [{ id: "all", label: "Всё" }, ...MASTERY_GROUPS];

const MASTERY_STATUS_FILTERS: Array<{
  id: MasteryStatusFilter;
  label: string;
}> = [
  { id: "pending", label: "Не освоено" },
  { id: "mastered", label: "Освоено" },
  { id: "all", label: "Любой статус" },
];

const PRICING_MASTERY_FILTERS: Array<{
  id: PricingMasteryFilter;
  label: string;
}> = [
  { id: "all", label: "Все" },
  { id: "mastered", label: "Освоено" },
  { id: "unmastered", label: "Не освоено" },
];

const SALE_HISTORY_TYPE_FILTERS: Array<{
  id: SaleRecordType | "all";
  label: string;
}> = [
  { id: "all", label: "Все" },
  { id: "item", label: "Предметы" },
  { id: "set", label: "Комплекты" },
];

const INVENTORY_ENTITY_COMPONENT_SUFFIXES = [
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

interface MasteryLookupEntry {
  sourceIds: string[];
  normalizedName: string;
}

interface PriceQueueJob {
  item: Pick<InventoryItem, "slug" | "name">;
  force: boolean;
  source: "auto" | "manual";
  started: boolean;
  cancelled: boolean;
  controller: AbortController | null;
  promise: Promise<PriceSnapshot | null>;
  resolve: (snapshot: PriceSnapshot | null) => void;
  reject: (error: Error) => void;
}

interface SaleMarksState {
  itemSlugs: string[];
  setSlugs: string[];
  itemSalePrices: Record<string, number | null>;
  setSalePrices: Record<string, number | null>;
}

interface SoldRecord {
  id: string;
  soldAt: string;
  type: SaleRecordType;
  source: SaleRecordSource;
  quantity: number;
  unitPrice: number | null;
  item: Pick<InventoryItem, "slug" | "name" | "names" | "assets">;
}

interface InventoryImportEntry {
  name: string;
  count: number;
}

interface ImportedInventoryMatch {
  item: MarketItem;
  quantity: number;
}

interface InventoryImageIssue {
  name: string;
  count: number;
}

interface MasteryImportEntry {
  name: string;
  isMastery: boolean;
}

interface ImportFeedback {
  tone: "success" | "error";
  message: string;
}

interface MasteryCatalogEntry {
  item: MasteryItem;
  sourceIds: string[];
}

interface WikiPageCacheEntry {
  savedAt: number;
  data: WikiPageData | null;
}

type WikiPageCache = Record<string, WikiPageCacheEntry>;

interface AssemblableSetDefinition {
  entityName: string;
  setItem: MarketItem;
  requiredPartSlugs: string[];
}

interface InventoryDisplayEntry {
  row: InventoryRow;
  masteryStatus: boolean | null;
  total: number | null;
  isAssemblableSet?: boolean;
  isMissingSet?: boolean;
  collectedPartCount?: number;
  requiredPartCount?: number;
  missingPartCount?: number;
  recipeSummary?: string;
  missingSummary?: string;
  recipeIngredients?: WikiCraftingIngredient[];
  searchText?: string;
}

interface WikiSetRowBuildOptions {
  rows: InventoryRow[];
  catalog: MarketItem[];
  catalogDisplayLookup: Map<string, MarketItem>;
  wikiPageCache: WikiPageCache;
  priceMap: Record<string, PriceSnapshot>;
  loadingSlugs: Set<string>;
  errors: Record<string, string | null>;
  pricingMasteryLookup: MasteryLookupEntry[];
  masteryProgress: Record<string, boolean>;
  language: AppLocale;
}

interface WikiSetRowBuildResult {
  craftableRows: InventoryDisplayEntry[];
  missingRows: InventoryDisplayEntry[];
}

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

function StatisticsSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M5.25 18.75h13.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M7.25 16.2v-4.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 16.2V8.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M16.75 16.2v-6.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M7.25 12.1 12 8.8l4.75 1.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.25" cy="12.1" r="0.95" fill="currentColor" />
      <circle cx="12" cy="8.8" r="0.95" fill="currentColor" />
      <circle cx="16.75" cy="10.7" r="0.95" fill="currentColor" />
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

function SaleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path
        d="M5.75 10.2V6.75A1.75 1.75 0 0 1 7.5 5h3.45l7.25 7.25a1.75 1.75 0 0 1 0 2.47l-3 3a1.75 1.75 0 0 1-2.47 0L5.75 10.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="9.2" cy="8.85" r="1.05" fill="currentColor" />
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

  if (section === "statistics") {
    return <StatisticsSectionIcon />;
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

function RefreshProgressBar({
  label,
  completed,
  total,
  remaining,
  active,
}: {
  label: string;
  completed: number;
  total: number;
  remaining: number;
  active: number;
}) {
  if (total <= 0) {
    return null;
  }

  const percent = Math.round((completed / total) * 100);
  const statusText =
    active > 0
      ? `В работе ${active}`
      : remaining > 0
        ? `Осталось обновить ${remaining}`
        : "Все обновлено";

  return (
    <div className={`refresh-progress${active > 0 ? " is-active" : ""}`}>
      <div className="refresh-progress-head">
        <span>{label}</span>
        <strong>
          {completed} / {total}
        </strong>
      </div>
      <div
        className="refresh-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={`${completed} из ${total} обновлено, осталось ${remaining}`}
      >
        <span
          className="refresh-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="refresh-progress-meta">
        <span>{statusText}</span>
        <span>{remaining > 0 ? `Не обновлено ${remaining}` : "Сводка актуальна"}</span>
      </div>
    </div>
  );
}

function FadeInImage({
  className,
  onLoad,
  src,
  ...props
}: ComponentPropsWithoutRef<"img">) {
  const [isLoaded, setIsLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setIsLoaded(false);
  }, [src]);

  useEffect(() => {
    const image = imageRef.current;

    if (image?.complete && image.naturalWidth > 0) {
      setIsLoaded(true);
    }
  }, [src]);

  return (
    <img
      {...props}
      ref={imageRef}
      className={className ? `fade-in-image ${className}` : "fade-in-image"}
      src={src}
      data-loaded={isLoaded ? "true" : "false"}
      onLoad={(event) => {
        setIsLoaded(true);
        onLoad?.(event);
      }}
    />
  );
}

function getMarketItemUrl(slug: string) {
  return `https://warframe.market/items/${slug}`;
}

function getMasteryGroupLabel(group: MasteryGroupFilterId) {
  return MASTERY_GROUP_FILTERS.find((entry) => entry.id === group)?.label ?? group;
}

function formatPlatinum(value: number | null) {
  if (value === null) {
    return "—";
  }

  return (
    <span className="price-value">
      <span>{value.toFixed(0)}</span>
      <FadeInImage
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

  return (
    <span className="price-value">
      <span>
        {new Intl.NumberFormat("ru-RU", {
          maximumFractionDigits: 0,
        }).format(value)}
      </span>
      <FadeInImage
        className="ducat-icon"
        src="/ducatIcon.webp"
        alt=""
        aria-hidden="true"
      />
    </span>
  );
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

function normalizeImportName(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/["'`’]/g, "")
    .replace(/[(){}\[\],.;:_/\\+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImportSearchName(value: string) {
  return normalizeImportName(value)
    .replace(/\bчерт(?:еж)?\b/g, " ")
    .replace(/\bпрайм\b/g, " ")
    .replace(/\bprime\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getEditDistance(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  const currentRow = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    currentRow[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;

      currentRow[rightIndex] = Math.min(
        previousRow[rightIndex] + 1,
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex - 1] + substitutionCost,
      );
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previousRow[rightIndex] = currentRow[rightIndex];
    }
  }

  return previousRow[right.length];
}

function getTextSimilarity(left: string, right: string) {
  if (!left || !right) {
    return 0;
  }

  const maxLength = Math.max(left.length, right.length);

  if (maxLength === 0) {
    return 1;
  }

  return 1 - getEditDistance(left, right) / maxLength;
}

function isPrimeSetName(value: string | undefined) {
  return typeof value === "string" && /\s+set$/i.test(value.trim());
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

function getPrimeEntityName(value: string) {
  let current = value.trim();
  let didChange = true;

  while (didChange && current.length > 0) {
    didChange = false;

    const withoutSet = trimTrailingWord(current, "set");

    if (withoutSet !== current) {
      current = withoutSet;
      didChange = true;
      continue;
    }

    for (const suffix of INVENTORY_ENTITY_COMPONENT_SUFFIXES) {
      const stripped = trimTrailingWord(current, suffix);

      if (stripped !== current) {
        current = stripped;
        didChange = true;
        break;
      }
    }
  }

  return current;
}

function sanitizeStoredInventory(items: InventoryItem[]) {
  return items.filter((item) => !isPrimeSetName(item.name));
}

function normalizeSaleMarksState(value: Partial<SaleMarksState> | null | undefined) {
  const itemSlugs = Array.isArray(value?.itemSlugs)
    ? value.itemSlugs.filter((slug): slug is string => typeof slug === "string")
    : [];
  const setSlugs = Array.isArray(value?.setSlugs)
    ? value.setSlugs.filter((slug): slug is string => typeof slug === "string")
    : [];
  const itemSlugSet = new Set(itemSlugs);
  const setSlugSet = new Set(setSlugs);
  const itemSalePrices = filterRecordByKeys(
    normalizeSalePriceMap(value?.itemSalePrices),
    itemSlugSet,
  );
  const setSalePrices = filterRecordByKeys(
    normalizeSalePriceMap(value?.setSalePrices),
    setSlugSet,
  );

  return {
    itemSlugs: [...new Set(itemSlugs)].sort(),
    setSlugs: [...new Set(setSlugs)].sort(),
    itemSalePrices,
    setSalePrices,
  };
}

function createSaleRecordId() {
  return `sale-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildManualSaleSlug(name: string, type: SaleRecordType) {
  const normalizedName = normalizeImportName(name)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9а-яё-]/gi, "");

  return `manual-${type}-${normalizedName || "entry"}`;
}

function normalizeStoredLocalizedNames(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const result: Partial<LocalizedNames> = {};

  if (typeof candidate.en === "string" && candidate.en.trim().length > 0) {
    result.en = candidate.en.trim();
  }

  if (typeof candidate.ru === "string" && candidate.ru.trim().length > 0) {
    result.ru = candidate.ru.trim();
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeStoredMarketAssets(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const result: Partial<MarketAssets> = {};

  for (const key of ["thumb", "icon", "badge"] as const) {
    const raw = candidate[key];

    if (typeof raw === "string" && raw.trim().length > 0) {
      result[key] = raw.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeSoldHistory(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as SoldRecord[];
  }

  const result: SoldRecord[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const itemCandidate = candidate.item;

    if (!itemCandidate || typeof itemCandidate !== "object" || Array.isArray(itemCandidate)) {
      continue;
    }

    const item = itemCandidate as Record<string, unknown>;
    const name =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.slug === "string" && item.slug.trim().length > 0
          ? item.slug.trim()
          : "";

    if (!name) {
      continue;
    }

    const rawType = candidate.type;
    const type: SaleRecordType = rawType === "set" ? "set" : "item";
    const slug =
      typeof item.slug === "string" && item.slug.trim().length > 0
        ? item.slug.trim()
        : buildManualSaleSlug(name, type);
    const quantity = Math.max(
      1,
      Math.floor(
        typeof candidate.quantity === "number" && Number.isFinite(candidate.quantity)
          ? candidate.quantity
          : 1,
      ),
    );
    const unitPrice =
      candidate.unitPrice === null
        ? null
        : typeof candidate.unitPrice === "number" && Number.isFinite(candidate.unitPrice)
          ? Math.max(0, Math.round(candidate.unitPrice))
          : null;
    const soldAt =
      typeof candidate.soldAt === "string" && !Number.isNaN(Date.parse(candidate.soldAt))
        ? candidate.soldAt
        : new Date().toISOString();
    const source: SaleRecordSource = candidate.source === "auto" ? "auto" : "manual";
    const names = normalizeStoredLocalizedNames(item.names);
    const assets = normalizeStoredMarketAssets(item.assets);

    result.push({
      id:
        typeof candidate.id === "string" && candidate.id.trim().length > 0
          ? candidate.id.trim()
          : createSaleRecordId(),
      soldAt,
      type,
      source,
      quantity,
      unitPrice,
      item: {
        slug,
        name,
        ...(names ? { names } : {}),
        ...(assets ? { assets } : {}),
      },
    });
  }

  return result.sort(
    (left, right) =>
      new Date(right.soldAt).getTime() - new Date(left.soldAt).getTime(),
  );
}

function matchesSoldHistorySearch(record: SoldRecord, normalizedSearch: string) {
  if (!normalizedSearch) {
    return true;
  }

  const targets = [
    record.item.slug,
    record.item.name,
    record.item.names?.en,
    record.item.names?.ru,
    record.source,
    record.type,
    formatSaleRecordTypeLabel(record.type),
    formatSaleRecordSourceLabel(record.source),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return targets.some((value) =>
    normalizeImportName(value).includes(normalizedSearch),
  );
}

function formatSaleRecordTypeLabel(type: SaleRecordType) {
  return type === "set" ? "Комплект" : "Предмет";
}

function formatSaleRecordSourceLabel(source: SaleRecordSource) {
  return source === "auto" ? "Авто" : "Ручная";
}

function normalizeSalePriceMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, number | null>;
  }

  const result: Record<string, number | null> = {};

  for (const [slug, price] of Object.entries(value as Record<string, unknown>)) {
    if (typeof slug !== "string") {
      continue;
    }

    if (price === null) {
      result[slug] = null;
      continue;
    }

    if (typeof price === "number" && Number.isFinite(price)) {
      result[slug] = price;
    }
  }

  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, number | null>;
}

function filterRecordByKeys<T>(
  record: Record<string, T>,
  allowedKeys: Set<string>,
) {
  let didChange = false;
  const nextEntries: Array<[string, T]> = [];

  for (const [key, value] of Object.entries(record)) {
    if (!allowedKeys.has(key)) {
      didChange = true;
      continue;
    }

    nextEntries.push([key, value as T]);
  }

  if (!didChange) {
    return record;
  }

  return Object.fromEntries(nextEntries) as Record<string, T>;
}

function setRecordValue<T>(
  record: Record<string, T>,
  key: string,
  value: T,
) {
  if (Object.prototype.hasOwnProperty.call(record, key) && record[key] === value) {
    return record;
  }

  return {
    ...record,
    [key]: value,
  };
}

function removeRecordValue<T>(record: Record<string, T>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return record;
  }

  const next = { ...record };
  delete next[key];

  return next;
}

function toggleSlugInList(slugs: string[], slug: string) {
  const next = new Set(slugs);

  if (next.has(slug)) {
    next.delete(slug);
  } else {
    next.add(slug);
  }

  return [...next].sort();
}

function removeSlugFromList(slugs: string[], slug: string) {
  const filtered = slugs.filter((currentSlug) => currentSlug !== slug);

  return filtered.length === slugs.length ? slugs : filtered;
}

function matchesInventorySearch(
  row: Pick<InventoryRow, "name" | "slug" | "names"> & {
    searchText?: string;
  },
  normalizedSearch: string,
) {
  if (!normalizedSearch) {
    return true;
  }

  const targets = [row.name, row.slug, row.names?.en, row.names?.ru].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  if (row.searchText) {
    targets.push(row.searchText);
  }

  return targets.some((value) =>
    normalizeImportName(value).includes(normalizedSearch),
  );
}

function addLookupNameEntry<T>(lookup: Map<string, T>, rawName: string | undefined, value: T) {
  if (!rawName) {
    return;
  }

  const normalizedName = normalizeImportName(rawName);

  if (!normalizedName || lookup.has(normalizedName)) {
    return;
  }

  lookup.set(normalizedName, value);
}

function isInventoryImportEntry(value: unknown): value is InventoryImportEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.name === "string" &&
    typeof candidate.count === "number" &&
    Number.isFinite(candidate.count)
  );
}

function isMasteryImportEntry(value: unknown): value is MasteryImportEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.name === "string" &&
    typeof candidate.isMastery === "boolean"
  );
}

function summarizeMissingNames(names: string[]) {
  if (names.length === 0) {
    return "";
  }

  const preview = names.slice(0, 4).join(", ");
  const suffix = names.length > 4 ? ` и ещё ${names.length - 4}` : "";
  return ` Не найдено: ${preview}${suffix}.`;
}

function buildMarketItemLookup(items: MarketItem[]) {
  const lookup = new Map<string, MarketItem>();

  for (const item of items) {
    if (isPrimeSetName(item.name)) {
      continue;
    }

    addLookupNameEntry(lookup, item.name, item);
    addLookupNameEntry(lookup, item.names.en, item);
    addLookupNameEntry(lookup, item.names.ru, item);
  }

  return lookup;
}

function buildCatalogItemLookup(items: MarketItem[]) {
  const lookup = new Map<string, MarketItem>();

  for (const item of items) {
    addLookupNameEntry(lookup, item.name, item);
    addLookupNameEntry(lookup, item.names.en, item);
    addLookupNameEntry(lookup, item.names.ru, item);
  }

  return lookup;
}

interface InventoryImageImportResult {
  items: InventoryItem[];
  removedItems: InventoryItem[];
  addedCount: number;
  updatedCount: number;
}

function buildInventoryImageImportResult(
  current: InventoryItem[],
  imported: Map<string, ImportedInventoryMatch>,
  mode: InventoryImageImportMode,
): InventoryImageImportResult {
  const items = [...imported.values()].map(({ item, quantity }) => {
    return {
      slug: item.slug,
      name: item.name,
      names: item.names,
      assets: item.assets,
      ducats: item.ducats,
      quantity,
    };
  });
  const currentMap = new Map(current.map((item) => [item.slug, item]));

  if (mode === "replace") {
    const importedSlugs = new Set(items.map((item) => item.slug));
    let addedCount = 0;
    let updatedCount = 0;

    for (const item of items) {
      const existing = currentMap.get(item.slug);

      if (!existing) {
        addedCount += 1;
      } else if (existing.quantity !== item.quantity) {
        updatedCount += 1;
      }
    }

    const removedItems = current.filter((item) => !importedSlugs.has(item.slug));

    return {
      items,
      removedItems,
      addedCount,
      updatedCount,
    };
  }

  const mergedItems = current.map((item) => {
    const importedItem = imported.get(item.slug);

    if (!importedItem) {
      return item;
    }

    const nextQuantity = Math.max(item.quantity, importedItem.quantity);

    return {
      ...item,
      ...importedItem.item,
      quantity: nextQuantity,
    };
  });

  let addedCount = 0;
  let updatedCount = 0;

  for (const item of items) {
    const existing = currentMap.get(item.slug);

    if (!existing) {
      addedCount += 1;
      mergedItems.push(item);
      continue;
    }

    if (item.quantity > existing.quantity) {
      updatedCount += 1;
    }
  }

  return {
    items: mergedItems,
    removedItems: [],
    addedCount,
    updatedCount,
  };
}

function getCatalogItemLookupCandidates(value: string) {
  const normalized = normalizeImportName(value);

  if (!normalized) {
    return [];
  }

  return [
    normalized,
    normalized.replace(/\s+/g, " "),
  ];
}

function resolveCatalogItemLike(
  items: MarketItem[],
  exactLookup: Map<string, MarketItem>,
  value: string,
  options?: { includeSets?: boolean },
) {
  const candidates = getCatalogItemLookupCandidates(value);

  for (const candidate of candidates) {
    const exact = exactLookup.get(candidate);

    if (exact && (options?.includeSets !== false || !isPrimeSetName(exact.name))) {
      return exact;
    }
  }

  const normalizedQuery = normalizeImportName(value);
  const searchableQuery = normalizeImportSearchName(value);

  if (!normalizedQuery && !searchableQuery) {
    return null;
  }

  const normalizedQueryTerms = (searchableQuery || normalizedQuery)
    .split(" ")
    .filter(Boolean);
  let bestItem: MarketItem | null = null;
  let bestScore = 0;

  for (const item of items) {
    if (options?.includeSets === false && isPrimeSetName(item.name)) {
      continue;
    }

    const itemCandidates = [item.name, item.names.en, item.names.ru].filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );

    for (const candidate of itemCandidates) {
      const normalizedCandidate = normalizeImportName(candidate);
      const searchableCandidate = normalizeImportSearchName(candidate);

      if (!normalizedCandidate && !searchableCandidate) {
        continue;
      }

      if (
        (normalizedCandidate && normalizedCandidate === normalizedQuery) ||
        (searchableCandidate && searchableCandidate === searchableQuery)
      ) {
        return item;
      }

      let score = 0;
      const primaryCandidate = searchableCandidate || normalizedCandidate;
      const primaryQuery = searchableQuery || normalizedQuery;

      if (primaryCandidate && primaryCandidate.startsWith(primaryQuery)) {
        score = Math.max(score, 100 - (primaryCandidate.length - primaryQuery.length));
      }

      if (primaryCandidate && primaryQuery.startsWith(primaryCandidate)) {
        score = Math.max(score, 90 - (primaryQuery.length - primaryCandidate.length));
      }

      const queryMatchCount = normalizedQueryTerms.filter((term) =>
        (primaryCandidate ?? normalizedCandidate).includes(term),
      ).length;

      if (queryMatchCount > 0) {
        score = Math.max(score, queryMatchCount * 10);
      }

      if (primaryCandidate && primaryQuery) {
        const similarity = getTextSimilarity(primaryCandidate, primaryQuery);

        if (similarity >= 0.68) {
          score = Math.max(score, Math.round(similarity * 100));
        }
      }

      if (normalizedCandidate && normalizedQuery) {
        const rawSimilarity = getTextSimilarity(normalizedCandidate, normalizedQuery);

        if (rawSimilarity >= 0.7) {
          score = Math.max(score, Math.round(rawSimilarity * 90));
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestItem = item;
      }
    }
  }

  return bestScore > 0 ? bestItem : null;
}

function buildAssemblableSetDefinitions(catalog: MarketItem[]) {
  const entries = new Map<
    string,
    {
      setItem: MarketItem | null;
      requiredPartSlugs: Set<string>;
    }
  >();

  for (const item of catalog) {
    const entityName = getPrimeEntityName(item.name);

    if (!entityName) {
      continue;
    }

    const current = entries.get(entityName) ?? {
      setItem: null,
      requiredPartSlugs: new Set<string>(),
    };

    if (isPrimeSetName(item.name)) {
      current.setItem = item;
    } else {
      current.requiredPartSlugs.add(item.slug);
    }

    entries.set(entityName, current);
  }

  const result: AssemblableSetDefinition[] = [];

  for (const [entityName, entry] of entries) {
    if (!entry.setItem || entry.requiredPartSlugs.size === 0) {
      continue;
    }

    result.push({
      entityName,
      setItem: entry.setItem,
      requiredPartSlugs: [...entry.requiredPartSlugs],
    });
  }

  return result;
}

function resolveMasteryStatus(
  name: string,
  lookup: MasteryLookupEntry[],
  progress: Record<string, boolean>,
) {
  const normalizedRowName = normalizeLookupText(name);
  const masteryMatch = lookup.find(
    (item) =>
      normalizedRowName === item.normalizedName ||
      normalizedRowName.startsWith(`${item.normalizedName} `),
  );

  return masteryMatch
    ? masteryMatch.sourceIds.some((itemId) => !!progress[itemId])
    : null;
}

function createInventoryDisplayEntry(
  row: InventoryRow,
  lookup: MasteryLookupEntry[],
  progress: Record<string, boolean>,
  metadata: Pick<
    InventoryDisplayEntry,
    | "isAssemblableSet"
    | "isMissingSet"
    | "collectedPartCount"
    | "requiredPartCount"
    | "missingPartCount"
    | "recipeSummary"
    | "missingSummary"
    | "recipeIngredients"
    | "searchText"
  > = {},
): InventoryDisplayEntry {
  return {
    ...metadata,
    row,
    masteryStatus: resolveMasteryStatus(row.name, lookup, progress),
    total:
      row.price?.minSellPrice !== null && row.price
        ? row.price.minSellPrice * row.quantity
        : null,
  };
}

function isWikiPageCacheFresh(entry: WikiPageCacheEntry) {
  if (!Number.isFinite(entry.savedAt)) {
    return false;
  }

  return Date.now() - entry.savedAt < WIKI_PAGE_CACHE_TTL_MS;
}

function summarizeWikiIngredients(
  ingredients: WikiCraftingIngredient[],
  catalogBySlug: Map<string, MarketItem>,
  language: AppLocale,
) {
  return ingredients
    .map((ingredient) => {
      const catalogItem = catalogBySlug.get(ingredient.slug);
      const displayName = catalogItem
        ? getLocalizedName(catalogItem.names, catalogItem.name, language)
        : ingredient.name;

      return `${displayName} ×${ingredient.quantity}`;
    })
    .join(", ");
}

function aggregateWikiCraftingIngredients(ingredients: WikiCraftingIngredient[]) {
  const requirements = new Map<string, WikiCraftingIngredient>();

  for (const ingredient of ingredients) {
    const current = requirements.get(ingredient.slug);

    if (current) {
      current.quantity += ingredient.quantity;
      continue;
    }

    requirements.set(ingredient.slug, { ...ingredient });
  }

  return [...requirements.values()];
}

function summarizeMissingWikiIngredients(
  ingredients: WikiCraftingIngredient[],
  catalogBySlug: Map<string, MarketItem>,
  language: AppLocale,
) {
  return ingredients
    .map((ingredient) => {
      const catalogItem = catalogBySlug.get(ingredient.slug);
      const displayName = catalogItem
        ? getLocalizedName(catalogItem.names, catalogItem.name, language)
        : ingredient.name;

      return `${displayName} ×${ingredient.quantity}`;
    })
    .join(", ");
}

function buildWikiSetRows(options: WikiSetRowBuildOptions): WikiSetRowBuildResult {
  const inventoryQuantities = new Map(
    options.rows.map((row) => [row.slug, row.quantity] as const),
  );
  const catalogBySlug = new Map(
    options.catalog.map((item) => [item.slug, item] as const),
  );
  const craftableRows: InventoryDisplayEntry[] = [];
  const missingRows: InventoryDisplayEntry[] = [];
  const seenSetSlugs = new Set<string>();

  for (const { data } of Object.values(options.wikiPageCache)) {
    if (!data) {
      continue;
    }

    const finalItem =
      resolveCatalogItemLike(
        options.catalog,
        options.catalogDisplayLookup,
        `${data.title} Set`,
      ) ?? resolveCatalogItemLike(options.catalog, options.catalogDisplayLookup, data.title);

    if (!finalItem) {
      continue;
    }

    if (seenSetSlugs.has(finalItem.slug)) {
      continue;
    }

    const requirements = aggregateWikiCraftingIngredients(data.ingredients);

    if (requirements.length === 0) {
      seenSetSlugs.add(finalItem.slug);
      continue;
    }

    let craftableCount = Number.POSITIVE_INFINITY;
    let requiredQuantity = 0;
    let collectedQuantity = 0;
    const missingIngredients: WikiCraftingIngredient[] = [];

    for (const ingredient of requirements) {
      requiredQuantity += ingredient.quantity;

      const ownedQuantity = inventoryQuantities.get(ingredient.slug) ?? 0;
      craftableCount = Math.min(
        craftableCount,
        Math.floor(ownedQuantity / ingredient.quantity),
      );
      collectedQuantity += Math.min(ownedQuantity, ingredient.quantity);

      const missingQuantity = Math.max(ingredient.quantity - ownedQuantity, 0);

      if (missingQuantity > 0) {
        missingIngredients.push({
          slug: ingredient.slug,
          name: ingredient.name,
          quantity: missingQuantity,
        });
      }
    }

    if (requiredQuantity < 2) {
      seenSetSlugs.add(finalItem.slug);
      continue;
    }

    const price = options.priceMap[finalItem.slug] ?? null;
    const baseRow = {
      slug: finalItem.slug,
      name: finalItem.name,
      names: finalItem.names,
      assets: finalItem.assets,
      ducats: finalItem.ducats,
      quantity: Math.max(0, Math.floor(craftableCount)),
      price,
      status: options.loadingSlugs.has(finalItem.slug)
        ? "loading"
        : options.errors[finalItem.slug]
          ? "error"
          : price
            ? "ready"
            : "idle",
      error: options.errors[finalItem.slug] ?? null,
    } satisfies InventoryRow;
    const recipeSummary = summarizeWikiIngredients(
      requirements,
      catalogBySlug,
      options.language,
    );

    if (craftableCount >= 1) {
      craftableRows.push(
        createInventoryDisplayEntry(
          baseRow,
          options.pricingMasteryLookup,
          options.masteryProgress,
          {
            isAssemblableSet: true,
            collectedPartCount: collectedQuantity,
            requiredPartCount: requiredQuantity,
            recipeSummary,
            recipeIngredients: requirements,
            searchText: recipeSummary,
          },
        ),
      );
    } else if (missingIngredients.length > 0) {
      const missingSummary = summarizeMissingWikiIngredients(
        missingIngredients,
        catalogBySlug,
        options.language,
      );

      missingRows.push(
        createInventoryDisplayEntry(
          baseRow,
          options.pricingMasteryLookup,
          options.masteryProgress,
          {
            isMissingSet: true,
            collectedPartCount: collectedQuantity,
            requiredPartCount: requiredQuantity,
            missingPartCount: requiredQuantity - collectedQuantity,
            recipeSummary,
            missingSummary,
            recipeIngredients: requirements,
            searchText: `${recipeSummary} ${missingSummary}`,
          },
        ),
      );
    }

    seenSetSlugs.add(finalItem.slug);
  }

  const sortByName = (left: InventoryDisplayEntry, right: InventoryDisplayEntry) =>
    getLocalizedName(left.row.names, left.row.name, options.language).localeCompare(
      getLocalizedName(right.row.names, right.row.name, options.language),
      options.language,
    );
  const sortMissingByCount = (left: InventoryDisplayEntry, right: InventoryDisplayEntry) => {
    const leftMissing = left.missingPartCount ?? Number.POSITIVE_INFINITY;
    const rightMissing = right.missingPartCount ?? Number.POSITIVE_INFINITY;

    if (leftMissing !== rightMissing) {
      return leftMissing - rightMissing;
    }

    return sortByName(left, right);
  };

  return {
    craftableRows: craftableRows.sort(sortByName),
    missingRows: missingRows.sort(sortMissingByCount),
  };
}

function groupMasteryCatalogEntries(items: MasteryItem[]) {
  const entries = new Map<string, MasteryCatalogEntry>();

  for (const item of items) {
    const key = getExactMasteryNameKey(item);
    const current = entries.get(key);

    if (!current) {
      entries.set(key, {
        item,
        sourceIds: [item.id],
      });
      continue;
    }

    current.item = mergeMasteryCatalogItems(current.item, item);

    if (!current.sourceIds.includes(item.id)) {
      current.sourceIds.push(item.id);
    }
  }

  return [...entries.values()];
}

function buildMasteryEntryLookup(entries: MasteryCatalogEntry[]) {
  const lookup = new Map<string, MasteryCatalogEntry>();

  for (const entry of entries) {
    addLookupNameEntry(lookup, entry.item.name, entry);
    addLookupNameEntry(lookup, entry.item.names.en, entry);
    addLookupNameEntry(lookup, entry.item.names.ru, entry);
  }

  return lookup;
}

function getExactMasteryNameKey(item: Pick<MasteryItem, "name">) {
  return item.name.trim().toLowerCase();
}

function mergeMasteryCatalogItems(existing: MasteryItem, next: MasteryItem): MasteryItem {
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

function isMasteryEntryMastered(
  entry: Pick<MasteryCatalogEntry, "sourceIds">,
  progress: Record<string, boolean>,
) {
  return entry.sourceIds.some((itemId) => !!progress[itemId]);
}

function buildExportFileName(prefix: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${timestamp}.json`;
}

function downloadJsonFile(prefix: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = buildExportFileName(prefix);
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    window.URL.revokeObjectURL(url);
  }, 0);
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

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryablePriceError(error: unknown) {
  return (
    error instanceof PriceFetchError &&
    (error.status === 429 || (error.status !== null && error.status >= 500))
  );
}

function isCooldownActive(meta: PriceRequestMeta | null | undefined) {
  if (!meta?.retryAfterAt) {
    return false;
  }

  return new Date(meta.retryAfterAt).getTime() > Date.now();
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

const BLUEPRINT_DISPLAY_SUFFIX_PATTERNS = [
  /\s*\((?:черт[её]ж|blueprint)\)$/i,
  /\s+(?:черт[её]ж|blueprint)$/i,
];

const BLUEPRINT_DISPLAY_SUFFIX_LABELS: Record<AppLocale, string> = {
  ru: "Чертеж",
  en: "Blueprint",
};

function stripBlueprintSuffix(value: string) {
  let current = value.trim();
  let didChange = true;

  while (didChange && current.length > 0) {
    didChange = false;

    for (const pattern of BLUEPRINT_DISPLAY_SUFFIX_PATTERNS) {
      const next = current.replace(pattern, "").trim();

      if (next !== current) {
        current = next;
        didChange = true;
        break;
      }
    }
  }

  return current || value.trim();
}

function hasBlueprintSuffix(value: string) {
  const trimmed = value.trim();

  return BLUEPRINT_DISPLAY_SUFFIX_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function getDisplayName(
  names: Partial<LocalizedNames> | undefined,
  fallback: string,
  language: AppLocale,
) {
  const localizedName = getLocalizedName(names, fallback, language);
  const displayName = stripBlueprintSuffix(localizedName);

  if (!hasBlueprintSuffix(localizedName) || displayName.includes(":")) {
    return displayName;
  }

  return `${displayName}: ${BLUEPRINT_DISPLAY_SUFFIX_LABELS[language]}`;
}

const ITEM_PREVIEW_PLACEHOLDER_IMAGE_PATTERN =
  /(?:question(?:[-_ ]?mark)?|unidentified(?:item)?|unknown|placeholder|missing)/i;

function isPlaceholderPreviewImage(url: string | null | undefined) {
  if (!url) {
    return false;
  }

  try {
    return ITEM_PREVIEW_PLACEHOLDER_IMAGE_PATTERN.test(new URL(url).pathname);
  } catch {
    return ITEM_PREVIEW_PLACEHOLDER_IMAGE_PATTERN.test(url);
  }
}

function getPreviewImageSources(item: {
  assets?: {
    thumb?: string | null;
    badge?: string | null;
    icon?: string | null;
  };
}) {
  const thumb = item.assets?.thumb ?? null;
  const badge = item.assets?.badge ?? null;
  const icon = item.assets?.icon ?? null;
  const preferredCandidates = isPlaceholderPreviewImage(thumb)
    ? [badge, icon, thumb]
    : [thumb, badge, icon];

  const candidates = preferredCandidates
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);

  const nonPlaceholderCandidates = candidates.filter(
    (candidate) => !isPlaceholderPreviewImage(candidate),
  );

  return nonPlaceholderCandidates.length > 0 ? nonPlaceholderCandidates : candidates;
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
      icon?: string | null;
      badge?: string | null;
    };
  };
  language: AppLocale;
}) {
  const displayName = getDisplayName(item.names, item.name, language);
  const previewImageSources = useMemo(
    () => getPreviewImageSources(item),
    [item.assets?.badge, item.assets?.icon, item.assets?.thumb],
  );
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(
    previewImageSources[0] ?? null,
  );
  const shouldShowBadge = !!item.assets?.badge && currentImageUrl !== item.assets.badge;

  useEffect(() => {
    setCurrentImageUrl(previewImageSources[0] ?? null);
  }, [item.slug, previewImageSources]);

  return (
    <div className="item-card-media">
      {currentImageUrl ? (
        <FadeInImage
          className="item-card-image"
          src={currentImageUrl}
          alt={displayName}
          loading="lazy"
          onError={() => {
            const currentIndex = previewImageSources.indexOf(currentImageUrl);
            const nextImageUrl = previewImageSources[currentIndex + 1] ?? null;

            if (nextImageUrl) {
              setCurrentImageUrl(nextImageUrl);
              return;
            }

            setCurrentImageUrl(null);
          }}
        />
      ) : (
        <div className="item-card-fallback" />
      )}
      {shouldShowBadge && item.assets?.badge && (
        <FadeInImage
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
  const displayName = getDisplayName(item.names, item.name, language);

  useEffect(() => {
    setCurrentImageUrl(item.imageUrl ?? item.fallbackImageUrl);
  }, [item.fallbackImageUrl, item.id, item.imageUrl]);

  return (
    <div className="item-card-media mastery-media">
      {currentImageUrl ? (
        <FadeInImage
          className="item-card-image mastery-card-image"
          src={currentImageUrl}
          alt={displayName}
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

function MasteryCardTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    const element = titleRef.current;

    if (!element) {
      return;
    }

    const measureOverflow = () => {
      setIsTruncated(element.scrollHeight > element.clientHeight + 1);
    };

    measureOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureOverflow);

      return () => {
        window.removeEventListener("resize", measureOverflow);
      };
    }

    const resizeObserver = new ResizeObserver(measureOverflow);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [title]);

  return (
    <strong
      ref={titleRef}
      className="item-card-title mastery-card-title"
      title={isTruncated ? title : undefined}
    >
      {title}
    </strong>
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
      icon?: string | null;
      badge?: string | null;
    };
  };
  language: AppLocale;
}) {
  const displayName = getDisplayName(item.names, item.name, language);
  const previewImageSources = useMemo(
    () => getPreviewImageSources(item),
    [item.assets?.badge, item.assets?.icon, item.assets?.thumb],
  );
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(
    previewImageSources[0] ?? null,
  );
  const shouldShowBadge = !!item.assets?.badge && currentImageUrl !== item.assets.badge;

  useEffect(() => {
    setCurrentImageUrl(previewImageSources[0] ?? null);
  }, [item.slug, previewImageSources]);

  return (
    <div className="item-thumb">
      {currentImageUrl ? (
        <FadeInImage
          className="item-thumb-image"
          src={currentImageUrl}
          alt={displayName}
          loading="lazy"
          onError={() => {
            const currentIndex = previewImageSources.indexOf(currentImageUrl);
            const nextImageUrl = previewImageSources[currentIndex + 1] ?? null;

            if (nextImageUrl) {
              setCurrentImageUrl(nextImageUrl);
              return;
            }

            setCurrentImageUrl(null);
          }}
        />
      ) : (
        <div className="item-thumb-fallback" />
      )}
      {shouldShowBadge && item.assets?.badge && (
        <FadeInImage
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
  const [inventory, setInventory] = useState<InventoryItem[]>(() =>
    sanitizeStoredInventory(loadFromStorage<InventoryItem[]>(INVENTORY_KEY, [])),
  );
  const [saleMarks, setSaleMarks] = useState<SaleMarksState>(() =>
    normalizeSaleMarksState(loadFromStorage<Partial<SaleMarksState>>(SALE_MARKS_KEY, {})),
  );
  const [soldHistory, setSoldHistory] = useState<SoldRecord[]>(() =>
    normalizeSoldHistory(loadFromStorage<unknown>(SOLD_HISTORY_KEY, [])),
  );
  const [wikiPageCache, setWikiPageCache] = useState<WikiPageCache>(() =>
    loadFromStorage<WikiPageCache>(WIKI_PAGE_CACHE_KEY, {}),
  );
  const [wikiPageState, setWikiPageState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [wikiPageError, setWikiPageError] = useState<string | null>(null);
  const [inventorySearch, setInventorySearch] = useState("");
  const [language, setLanguage] = useState<AppLocale>(() =>
    loadFromStorage<AppLocale>(LANGUAGE_KEY, "ru"),
  );
  const [activeSection, setActiveSection] = useState<AppSection>("inventory");
  const [marketUsername, setMarketUsername] = useState(() =>
    loadFromStorage<string>(MARKET_USERNAME_KEY, ""),
  );
  const [marketUsernameInput, setMarketUsernameInput] = useState(marketUsername);
  const [priceMap, setPriceMap] = useState<Record<string, PriceSnapshot>>(() =>
    loadCachedPriceSnapshots(marketUsername),
  );
  const [priceRequestMetaMap, setPriceRequestMetaMap] = useState<
    Record<string, PriceRequestMeta>
  >(() =>
    loadFromStorage<Record<string, PriceRequestMeta>>(PRICE_REQUEST_META_KEY, {}),
  );
  const [loadingSlugs, setLoadingSlugs] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [isBulkRefreshing, setIsBulkRefreshing] = useState(false);
  const [queuedPriceJobCount, setQueuedPriceJobCount] = useState(0);
  const [isAutoPriceRefreshPaused, setIsAutoPriceRefreshPaused] = useState(false);
  const [isRefreshAllButtonHovered, setIsRefreshAllButtonHovered] = useState(false);
  const [masteryCatalog, setMasteryCatalog] = useState<MasteryItem[]>([]);
  const [masteryCatalogState, setMasteryCatalogState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [masteryCatalogError, setMasteryCatalogError] = useState<string | null>(
    null,
  );
  const [masterySearch, setMasterySearch] = useState("");
  const [masteryGroup, setMasteryGroup] = useState<MasteryGroupFilterId>("all");
  const [masteryStatusFilter, setMasteryStatusFilter] =
    useState<MasteryStatusFilter>("pending");
  const [inventoryImportFeedback, setInventoryImportFeedback] =
    useState<ImportFeedback | null>(null);
  const [masteryImportFeedback, setMasteryImportFeedback] =
    useState<ImportFeedback | null>(null);
  const [inventoryImageImportFeedback, setInventoryImageImportFeedback] =
    useState<ImportFeedback | null>(null);
  const [inventoryImageImportIssues, setInventoryImageImportIssues] = useState<
    InventoryImageIssue[]
  >([]);
  const [inventoryImageImportMode, setInventoryImageImportMode] =
    useState<InventoryImageImportMode>(() => {
      const storedMode = loadFromStorage<unknown>(
        INVENTORY_IMAGE_IMPORT_MODE_KEY,
        "append",
      );

      return isInventoryImageImportMode(storedMode) ? storedMode : "append";
    });
  const [saleHistoryFeedback, setSaleHistoryFeedback] =
    useState<ImportFeedback | null>(null);
  const [isInventoryImageImporting, setIsInventoryImageImporting] =
    useState(false);
  const [masteryProgress, setMasteryProgress] = useState<Record<string, boolean>>(
    () => loadFromStorage<Record<string, boolean>>(MASTERY_PROGRESS_KEY, {}),
  );
  const [visibleMasteryCount, setVisibleMasteryCount] = useState(
    SECTION_RENDER_CHUNK_SIZE,
  );
  const [visibleInventoryCount, setVisibleInventoryCount] = useState(
    SECTION_RENDER_CHUNK_SIZE,
  );
  const [visiblePricingCount, setVisiblePricingCount] = useState(
    SECTION_RENDER_CHUNK_SIZE,
  );
  const [visibleDucatCount, setVisibleDucatCount] = useState(
    SECTION_RENDER_CHUNK_SIZE,
  );
  const [inventoryShowAssemblableSetsOnly, setInventoryShowAssemblableSetsOnly] =
    useState(false);
  const [
    inventoryShowMissingSetRequirementsOnly,
    setInventoryShowMissingSetRequirementsOnly,
  ] = useState(false);
  const [pricingShowAssemblableSetsOnly, setPricingShowAssemblableSetsOnly] =
    useState(false);
  const [pricingSearch, setPricingSearch] = useState("");
  const [pricingShowOnSaleOnly, setPricingShowOnSaleOnly] = useState(false);
  const [inventoryMasteryFilter, setInventoryMasteryFilter] =
    useState<PricingMasteryFilter>("all");
  const [inventorySort, setInventorySort] =
    useState<InventorySortState>(null);
  const [pricingMasteryFilter, setPricingMasteryFilter] =
    useState<PricingMasteryFilter>("mastered");
  const [ducatsMasteryFilter, setDucatsMasteryFilter] =
    useState<PricingMasteryFilter>("mastered");
  const [saleHistorySearch, setSaleHistorySearch] = useState("");
  const [saleHistoryTypeFilter, setSaleHistoryTypeFilter] =
    useState<SaleRecordType | "all">("all");
  const [saleFormName, setSaleFormName] = useState("");
  const [saleFormType, setSaleFormType] = useState<SaleRecordType>("item");
  const [saleFormQuantity, setSaleFormQuantity] = useState("1");
  const [saleFormUnitPrice, setSaleFormUnitPrice] = useState("");
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
  const inventoryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const pricingLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const ducatsLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const inventoryImportInputRef = useRef<HTMLInputElement | null>(null);
  const inventoryImageImportInputRef = useRef<HTMLInputElement | null>(null);
  const masteryImportInputRef = useRef<HTMLInputElement | null>(null);
  const isMountedRef = useRef(true);
  const marketUsernameLoadedRef = useRef(false);
  const masteryCatalogRequestRef = useRef<Promise<MasteryItem[]> | null>(null);
  const queuedPriceJobsRef = useRef<Map<string, PriceQueueJob>>(new Map());
  const queuedPriceSlugsRef = useRef<string[]>([]);
  const activePriceRequestsRef = useRef(0);
  const activeTargetSlugsRef = useRef<Set<string>>(new Set());
  const wikiPageCacheRef = useRef<WikiPageCache>(wikiPageCache);
  const deferredMasterySearch = useDeferredValue(
    masterySearch.trim().toLowerCase(),
  );
  const deferredInventorySearch = useDeferredValue(
    normalizeImportName(inventorySearch),
  );
  const deferredPricingSearch = useDeferredValue(
    normalizeImportName(pricingSearch),
  );
  const catalogImportLookup = useMemo(() => buildMarketItemLookup(catalog), [catalog]);
  const catalogDisplayLookup = useMemo(() => buildCatalogItemLookup(catalog), [catalog]);
  const primeSetCatalog = useMemo(
    () => catalog.filter((item) => isPrimeSetName(item.name)),
    [catalog],
  );
  const primeSetLookup = useMemo(
    () => buildCatalogItemLookup(primeSetCatalog),
    [primeSetCatalog],
  );
  const masteryImportLookup = useMemo(
    () => buildMasteryEntryLookup(groupMasteryCatalogEntries(masteryCatalog)),
    [masteryCatalog],
  );
  const deferredSaleHistorySearch = useDeferredValue(
    normalizeImportName(saleHistorySearch),
  );
  const isCraftableSetInventoryView = inventoryShowAssemblableSetsOnly;
  const isMissingSetInventoryView = inventoryShowMissingSetRequirementsOnly;

  useEffect(() => {
    if (activeSection === "statistics" && APP_SECTIONS.find((section) => section.id === "statistics")?.disabled) {
      setActiveSection("inventory");
    }
  }, [activeSection]);

  async function ensureMasteryCatalogLoaded(forceRefresh = false) {
    if (!forceRefresh && masteryCatalogState === "ready" && masteryCatalog.length > 0) {
      return masteryCatalog;
    }

    if (masteryCatalogRequestRef.current) {
      return masteryCatalogRequestRef.current;
    }

    const request = (async () => {
      try {
        setMasteryCatalogState("loading");
        const items = await fetchMasteryCatalog(forceRefresh);

        setMasteryCatalog(items);
        setMasteryCatalogState("ready");
        setMasteryCatalogError(null);

        return items;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Не удалось загрузить список mastery-предметов";

        setMasteryCatalogState("error");
        setMasteryCatalogError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        masteryCatalogRequestRef.current = null;
      }
    })();

    masteryCatalogRequestRef.current = request;

    return request;
  }

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveToStorage(INVENTORY_KEY, inventory);
  }, [inventory]);

  useEffect(() => {
    saveToStorage(LANGUAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    saveToStorage(INVENTORY_IMAGE_IMPORT_MODE_KEY, inventoryImageImportMode);
  }, [inventoryImageImportMode]);

  useEffect(() => {
    saveToStorage(MARKET_USERNAME_KEY, marketUsername);
  }, [marketUsername]);

  useEffect(() => {
    setMarketUsernameInput(marketUsername);
  }, [marketUsername]);

  useEffect(() => {
    if (!marketUsernameLoadedRef.current) {
      marketUsernameLoadedRef.current = true;
      return;
    }

    cancelAllPriceJobs();
    queuedPriceSlugsRef.current = [];
    setQueuedPriceJobCount(0);
    setLoadingSlugs(new Set());
    setErrors({});
    setPriceRequestMetaMap({});
    setPriceMap(loadCachedPriceSnapshots(marketUsername));
  }, [marketUsername]);

  useEffect(() => {
    saveToStorage(MASTERY_PROGRESS_KEY, masteryProgress);
  }, [masteryProgress]);

  useEffect(() => {
    saveToStorage(PRICE_REQUEST_META_KEY, priceRequestMetaMap);
  }, [priceRequestMetaMap]);

  useEffect(() => {
    saveToStorage(SALE_MARKS_KEY, saleMarks);
  }, [saleMarks]);

  useEffect(() => {
    saveToStorage(SOLD_HISTORY_KEY, soldHistory);
  }, [soldHistory]);

  useEffect(() => {
    wikiPageCacheRef.current = wikiPageCache;
  }, [wikiPageCache]);

  useEffect(() => {
    saveToStorage(WIKI_PAGE_CACHE_KEY, wikiPageCache);
  }, [wikiPageCache]);

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
    if (catalogState !== "ready" || catalogImportLookup.size === 0) {
      setWikiPageState("idle");
      setWikiPageError(null);
      return;
    }

    if (inventory.length === 0) {
      setWikiPageState("idle");
      setWikiPageError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadWikiPages() {
      try {
        setWikiPageState("loading");
        setWikiPageError(null);

        let workingCache = { ...wikiPageCacheRef.current };
        const queue = new Set<string>();
        const queued = new Set<string>();
        const processed = new Set<string>();
        let firstError: string | null = null;

        function enqueueCandidate(title: string) {
          const normalized = normalizeWikiPageTitle(title);

          if (!normalized) {
            return;
          }

          if (processed.has(normalized) || queued.has(normalized)) {
            return;
          }

          const cached = workingCache[normalized];

          if (cached && isWikiPageCacheFresh(cached)) {
            processed.add(normalized);
            return;
          }

          queue.add(normalized);
          queued.add(normalized);
        }

        for (const item of inventory) {
          enqueueCandidate(getPrimeEntityName(item.name));
        }

        if (queue.size === 0) {
          if (!cancelled) {
            setWikiPageState("ready");
            setWikiPageError(null);
          }
          return;
        }

        while (queue.size > 0 && !cancelled) {
          const batch = [...queue].slice(0, 4);

          for (const title of batch) {
            queue.delete(title);
          }

          const results = await Promise.all(
            batch.map(async (title) => {
              const cached = workingCache[title];

              if (cached && isWikiPageCacheFresh(cached)) {
                return {
                  requestedTitle: title,
                  canonicalTitle: cached.data?.title ?? title,
                  data: cached.data,
                  error: null as string | null,
                };
              }

              try {
                const data = await fetchWikiPageData(
                  title,
                  (name) =>
                    resolveCatalogItemLike(catalog, catalogImportLookup, name, {
                      includeSets: false,
                    }),
                  controller.signal,
                );

                return {
                  requestedTitle: title,
                  canonicalTitle: data?.title ?? title,
                  data,
                  error: null as string | null,
                };
              } catch (error) {
                if (isAbortError(error) || cancelled) {
                  return {
                    requestedTitle: title,
                    canonicalTitle: title,
                    data: null,
                    error: null as string | null,
                  };
                }

                const message =
                  error instanceof Error ? error.message : "Не удалось загрузить вики";

                return {
                  requestedTitle: title,
                  canonicalTitle: title,
                  data: null,
                  error: message,
                };
              }
            }),
          );

          if (cancelled) {
            break;
          }

          const savedAt = Date.now();

          for (const result of results) {
            const cacheEntry: WikiPageCacheEntry = {
              savedAt,
              data: result.data,
            };

            workingCache[result.requestedTitle] = cacheEntry;

            if (result.canonicalTitle && result.canonicalTitle !== result.requestedTitle) {
              workingCache[result.canonicalTitle] = cacheEntry;
            }

            processed.add(result.requestedTitle);
            processed.add(result.canonicalTitle);
            queued.delete(result.requestedTitle);
            queued.delete(result.canonicalTitle);

            if (result.error && !firstError) {
              firstError = result.error;
            }

            if (!result.data) {
              continue;
            }

            for (const candidate of result.data.candidateTitles) {
              enqueueCandidate(candidate);
            }
          }
        }

        if (cancelled) {
          return;
        }

        const hasAnyData = Object.values(workingCache).some((entry) => !!entry.data);

        setWikiPageCache(workingCache);
        setWikiPageState(firstError && !hasAnyData ? "error" : "ready");
        setWikiPageError(firstError && !hasAnyData ? firstError : null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "Не удалось загрузить вики";

        setWikiPageState("error");
        setWikiPageError(message);
      }
    }

    void loadWikiPages();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [catalogImportLookup, catalogState, inventory]);

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

    void ensureMasteryCatalogLoaded();
  }, [activeSection, masteryCatalogState]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [activeSection]);

  useEffect(() => {
    setVisibleMasteryCount(SECTION_RENDER_CHUNK_SIZE);
  }, [deferredMasterySearch, masteryGroup, masteryStatusFilter]);

  useEffect(() => {
    setVisibleInventoryCount(SECTION_RENDER_CHUNK_SIZE);
  }, [
    deferredInventorySearch,
    inventoryMasteryFilter,
    inventoryShowAssemblableSetsOnly,
    inventoryShowMissingSetRequirementsOnly,
  ]);

  useEffect(() => {
    setVisiblePricingCount(SECTION_RENDER_CHUNK_SIZE);
  }, [pricingMasteryFilter, pricingSort?.direction, pricingSort?.key]);

  useEffect(() => {
    setVisibleDucatCount(SECTION_RENDER_CHUNK_SIZE);
  }, [ducatSort.direction, ducatSort.key, ducatsMasteryFilter]);

  function syncQueuedPriceJobCount() {
    setQueuedPriceJobCount(queuedPriceJobsRef.current.size);
  }

  function cancelPriceJob(slug: string) {
    const job = queuedPriceJobsRef.current.get(slug);

    if (!job) {
      return;
    }

    job.cancelled = true;
    queuedPriceJobsRef.current.delete(slug);
    queuedPriceSlugsRef.current = queuedPriceSlugsRef.current.filter(
      (queuedSlug) => queuedSlug !== slug,
    );
    syncQueuedPriceJobCount();

    if (job.started && job.controller) {
      job.controller.abort();
      job.resolve(null);
    } else {
      job.resolve(null);
    }

    if (isMountedRef.current) {
      setLoadingSlugs((current) => {
        const next = new Set(current);
        next.delete(slug);
        return next;
      });
    }
  }

  function cancelAutoPriceJobs(targetSlugs: Set<string>) {
    for (const [slug, job] of queuedPriceJobsRef.current.entries()) {
      if (job.source === "auto" && !targetSlugs.has(slug)) {
        cancelPriceJob(slug);
      }
    }
  }

  function processPriceQueue() {
    while (activePriceRequestsRef.current < PRICE_QUEUE_CONCURRENCY) {
      const slug = queuedPriceSlugsRef.current.shift();

      if (!slug) {
        return;
      }

      const job = queuedPriceJobsRef.current.get(slug);

      if (!job || job.started || job.cancelled) {
        continue;
      }

      if (job.source === "auto" && !activeTargetSlugsRef.current.has(slug)) {
        cancelPriceJob(slug);
        continue;
      }

      job.started = true;
      job.controller = new AbortController();
      activePriceRequestsRef.current += 1;
      setLoadingSlugs((current) => new Set(current).add(slug));
      setErrors((current) => ({ ...current, [slug]: null }));
      const attemptAt = new Date().toISOString();

      setPriceRequestMetaMap((current) => ({
        ...current,
        [slug]: {
          lastAttemptAt: attemptAt,
          lastSuccessAt: current[slug]?.lastSuccessAt ?? null,
          retryAfterAt: current[slug]?.retryAfterAt ?? null,
          lastErrorStatus: null,
          lastErrorMessage: null,
        },
      }));

      void fetchPrimePrice(job.item, {
        force: job.force,
        signal: job.controller.signal,
        marketUsername,
      })
        .then((snapshot) => {
          const isCurrentJob = queuedPriceJobsRef.current.get(slug) === job;

          if (isMountedRef.current && isCurrentJob && !job.cancelled && snapshot) {
            setPriceMap((current) => ({ ...current, [slug]: snapshot }));
            setPriceRequestMetaMap((current) => ({
              ...current,
              [slug]: {
                lastAttemptAt: snapshot.lastAttemptAt ?? attemptAt,
                lastSuccessAt: snapshot.lastSuccessAt ?? snapshot.updatedAt,
                retryAfterAt: null,
                lastErrorStatus: null,
                lastErrorMessage: null,
              },
            }));
          }

          job.resolve(snapshot);
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || job.cancelled) {
            job.resolve(null);
            return;
          }

          const normalizedError =
            error instanceof Error
              ? error
              : new Error("Не удалось получить цену");
          const isCurrentJob = queuedPriceJobsRef.current.get(slug) === job;
          const retryAfterAt = new Date(
            Date.now() +
              (isRetryablePriceError(normalizedError)
                ? PRICE_ERROR_COOLDOWN_MS
                : PRICE_GENERAL_RETRY_MS),
          ).toISOString();
          const lastErrorStatus =
            normalizedError instanceof PriceFetchError
              ? normalizedError.status
              : null;

          if (isMountedRef.current && isCurrentJob) {
            setErrors((current) => ({
              ...current,
              [slug]: normalizedError.message,
            }));
            setPriceRequestMetaMap((current) => ({
              ...current,
              [slug]: {
                lastAttemptAt: attemptAt,
                lastSuccessAt: current[slug]?.lastSuccessAt ?? null,
                retryAfterAt,
                lastErrorStatus,
                lastErrorMessage: normalizedError.message,
              },
            }));
          }

          job.reject(normalizedError);
        })
        .finally(() => {
          activePriceRequestsRef.current = Math.max(
            0,
            activePriceRequestsRef.current - 1,
          );
          const currentJob = queuedPriceJobsRef.current.get(slug);

          if (currentJob === job) {
            queuedPriceJobsRef.current.delete(slug);
            syncQueuedPriceJobCount();
          }

          if (isMountedRef.current) {
            setLoadingSlugs((current) => {
              const next = new Set(current);
              next.delete(slug);
              return next;
            });

            window.setTimeout(() => {
              if (isMountedRef.current) {
                processPriceQueue();
              }
            }, PRICE_QUEUE_DELAY_MS);
          }
        });
    }
  }

  function queuePriceRefresh(
    item: Pick<InventoryItem, "slug" | "name">,
    options?: { force?: boolean; source?: "auto" | "manual" },
  ) {
    const requestMeta = priceRequestMetaMap[item.slug];

    if (isCooldownActive(requestMeta)) {
      const retryAt = requestMeta?.retryAfterAt
        ? new Intl.DateTimeFormat("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(requestMeta.retryAfterAt))
        : null;
      const cooldownError = new Error(
        retryAt
          ? `Повторный запрос временно отключен до ${retryAt}`
          : "Повторный запрос временно отключен",
      );

      if (options?.source === "manual") {
        setErrors((current) => ({
          ...current,
          [item.slug]: cooldownError.message,
        }));
      }

      return Promise.reject(cooldownError);
    }

    const existingJob = queuedPriceJobsRef.current.get(item.slug);

    if (existingJob) {
      if (!existingJob.started && options?.force) {
        existingJob.force = true;
      }

      if (options?.source === "manual") {
        existingJob.source = "manual";
      }

      return existingJob.promise;
    }

    let resolveJob!: (snapshot: PriceSnapshot | null) => void;
    let rejectJob!: (error: Error) => void;
    const promise = new Promise<PriceSnapshot | null>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });

    queuedPriceJobsRef.current.set(item.slug, {
      item,
      force: !!options?.force,
      source: options?.source ?? "auto",
      started: false,
      cancelled: false,
      controller: null,
      promise,
      resolve: resolveJob,
      reject: rejectJob,
    });
    queuedPriceSlugsRef.current.push(item.slug);
    syncQueuedPriceJobCount();
    processPriceQueue();

    return promise;
  }

  async function refreshItem(item: Pick<InventoryItem, "slug" | "name">, force = false) {
    try {
      return await queuePriceRefresh(item, { force, source: "manual" });
    } catch {
      return null;
    }
  }

  useEffect(() => {
    const inventorySlugs = new Set(inventory.map((item) => item.slug));

    for (const slug of [...queuedPriceJobsRef.current.keys()]) {
      if (!inventorySlugs.has(slug)) {
        cancelPriceJob(slug);
      }
    }

    setPriceMap((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        inventorySlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });

    setPriceRequestMetaMap((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        inventorySlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });

    setErrors((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        inventorySlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [inventory]);

  const suggestions = useMemo(() => {
    const normalizedSearch = inventorySearch.trim().toLowerCase();

    if (normalizedSearch.length < 2) {
      return [];
    }

    const existing = new Set(inventory.map((item) => item.slug));

    return catalog
      .filter((item) => {
        if (existing.has(item.slug)) {
          return false;
        }

        if (isPrimeSetName(item.name)) {
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
  }, [catalog, inventory, inventorySearch, language]);

  const rows = useMemo(
    () => mergeRows(inventory, catalog, priceMap, loadingSlugs, errors),
    [catalog, inventory, priceMap, loadingSlugs, errors],
  );
  const activeSectionMeta =
    APP_SECTIONS.find((section) => section.id === activeSection) ?? APP_SECTIONS[0];
  const saleHistorySummary = useMemo(() => {
    return soldHistory.reduce(
      (summary, record) => {
        summary.records += 1;
        summary.units += record.quantity;
        summary.revenue +=
          record.unitPrice !== null ? record.unitPrice * record.quantity : 0;
        summary.setUnits += record.type === "set" ? record.quantity : 0;
        summary.itemUnits += record.type === "item" ? record.quantity : 0;
        summary.manualRecords += record.source === "manual" ? 1 : 0;
        summary.autoRecords += record.source === "auto" ? 1 : 0;
        summary.uniqueSlugs.add(record.item.slug);
        return summary;
      },
      {
        records: 0,
        units: 0,
        revenue: 0,
        setUnits: 0,
        itemUnits: 0,
        manualRecords: 0,
        autoRecords: 0,
        uniqueSlugs: new Set<string>(),
      },
    );
  }, [soldHistory]);
  const filteredSoldHistory = useMemo(() => {
    return soldHistory.filter((record) => {
      if (saleHistoryTypeFilter !== "all" && record.type !== saleHistoryTypeFilter) {
        return false;
      }

      return matchesSoldHistorySearch(record, deferredSaleHistorySearch);
    });
  }, [deferredSaleHistorySearch, saleHistoryTypeFilter, soldHistory]);
  const saleFormResolvedItem = useMemo(() => {
    const trimmedName = saleFormName.trim();

    if (!trimmedName) {
      return null;
    }

    return saleFormType === "set"
      ? resolveCatalogItemLike(primeSetCatalog, primeSetLookup, trimmedName)
      : resolveCatalogItemLike(catalog, catalogImportLookup, trimmedName, {
          includeSets: false,
        });
  }, [
    catalog,
    catalogImportLookup,
    primeSetCatalog,
    primeSetLookup,
    saleFormName,
    saleFormType,
  ]);
  const saleFormResolvedDisplayName = saleFormResolvedItem
    ? getDisplayName(saleFormResolvedItem.names, saleFormResolvedItem.name, language)
    : null;

  const masteryCatalogEntries = useMemo(
    () => groupMasteryCatalogEntries(masteryCatalog),
    [masteryCatalog],
  );
  const primeMasteryCatalogEntries = useMemo(
    () => masteryCatalogEntries.filter(({ item }) => isPrimeMasteryItem(item)),
    [masteryCatalogEntries],
  );

  const masteryTotals = useMemo(() => {
    const mastered = primeMasteryCatalogEntries.reduce(
      (count, entry) => count + (isMasteryEntryMastered(entry, masteryProgress) ? 1 : 0),
      0,
    );
    const total = primeMasteryCatalogEntries.length;

    return {
      total,
      mastered,
      remaining: Math.max(total - mastered, 0),
      completionRate: total > 0 ? mastered / total : 0,
    };
  }, [masteryProgress, primeMasteryCatalogEntries]);

  const masteryGroupStats = useMemo(() => {
    const stats = Object.fromEntries(
      MASTERY_GROUPS.map((group) => [group.id, { total: 0, mastered: 0 }]),
    ) as Record<MasteryGroupId, { total: number; mastered: number }>;

    for (const entry of primeMasteryCatalogEntries) {
      const { item } = entry;
      stats[item.group].total += 1;

      if (isMasteryEntryMastered(entry, masteryProgress)) {
        stats[item.group].mastered += 1;
      }
    }

    return stats;
  }, [masteryProgress, primeMasteryCatalogEntries]);

  const pricingMasteryLookup = useMemo(() => {
    return primeMasteryCatalogEntries
      .map(({ item, sourceIds }) => ({
        sourceIds,
        normalizedName: normalizeLookupText(item.name),
      }))
      .sort((left, right) => right.normalizedName.length - left.normalizedName.length);
  }, [primeMasteryCatalogEntries]);

  const rowsWithMastery = useMemo(() => {
    return rows.map((row) =>
      createInventoryDisplayEntry(row, pricingMasteryLookup, masteryProgress),
    );
  }, [masteryProgress, pricingMasteryLookup, rows]);

  const { craftableRows: wikiSetRows, missingRows: wikiMissingSetRows } = useMemo(
    () =>
      buildWikiSetRows({
        rows,
        catalog,
        catalogDisplayLookup,
        wikiPageCache,
        priceMap,
        loadingSlugs,
        errors,
        pricingMasteryLookup,
        masteryProgress,
        language,
      }),
    [
      catalog,
      catalogDisplayLookup,
      errors,
      language,
      masteryProgress,
      loadingSlugs,
      priceMap,
      pricingMasteryLookup,
      rows,
      wikiPageCache,
    ],
  );

  const inventorySourceRows = useMemo(
    () =>
      isCraftableSetInventoryView
        ? wikiSetRows
        : isMissingSetInventoryView
          ? wikiMissingSetRows
          : rowsWithMastery,
    [isCraftableSetInventoryView, isMissingSetInventoryView, rowsWithMastery, wikiMissingSetRows, wikiSetRows],
  );

  const pricingSourceRows = useMemo(
    () => (pricingShowAssemblableSetsOnly ? wikiSetRows : rowsWithMastery),
    [pricingShowAssemblableSetsOnly, rowsWithMastery, wikiSetRows],
  );

  const saleItemSlugSet = useMemo(
    () => new Set(saleMarks.itemSlugs),
    [saleMarks.itemSlugs],
  );
  const saleSetSlugSet = useMemo(
    () => new Set(saleMarks.setSlugs),
    [saleMarks.setSlugs],
  );
  const setComponentLookup = useMemo(() => {
    const lookup = new Map<string, Set<string>>();

    for (const entry of wikiSetRows) {
      if (!entry.recipeIngredients) {
        continue;
      }

      for (const ingredient of entry.recipeIngredients) {
        const current = lookup.get(ingredient.slug);

        if (current) {
          current.add(entry.row.slug);
        } else {
          lookup.set(ingredient.slug, new Set([entry.row.slug]));
        }
      }
    }

    return lookup;
  }, [wikiSetRows]);

  useEffect(() => {
    if (wikiPageState !== "ready") {
      return;
    }

    const inventorySlugs = new Set(inventory.map((item) => item.slug));
    const availableSetSlugs = new Set(wikiSetRows.map((entry) => entry.row.slug));

    setSaleMarks((current) => {
      const nextItemSlugs = current.itemSlugs.filter((slug) => inventorySlugs.has(slug));
      const nextSetSlugs = current.setSlugs.filter((slug) => availableSetSlugs.has(slug));
      const nextItemSalePrices = filterRecordByKeys(
        current.itemSalePrices,
        inventorySlugs,
      );
      const nextSetSalePrices = filterRecordByKeys(
        current.setSalePrices,
        availableSetSlugs,
      );

      if (
        nextItemSlugs.length === current.itemSlugs.length &&
        nextSetSlugs.length === current.setSlugs.length &&
        nextItemSlugs.every((slug, index) => slug === current.itemSlugs[index]) &&
        nextSetSlugs.every((slug, index) => slug === current.setSlugs[index]) &&
        nextItemSalePrices === current.itemSalePrices &&
        nextSetSalePrices === current.setSalePrices
      ) {
        return current;
      }

      return {
        itemSlugs: nextItemSlugs,
        setSlugs: nextSetSlugs,
        itemSalePrices: nextItemSalePrices,
        setSalePrices: nextSetSalePrices,
      };
    });
  }, [inventory, wikiPageState, wikiSetRows]);

  const inventoryRows = useMemo(() => {
    const filteredRows = inventorySourceRows.filter((entry) => {
      if (!matchesInventorySearch(entry.row, deferredInventorySearch)) {
        return false;
      }

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
    if (!inventorySort) {
      return filteredRows;
    }

    const collator = new Intl.Collator(language, { numeric: true });

    return [...filteredRows].sort((left, right) => {
      const leftName = getDisplayName(left.row.names, left.row.name, language);
      const rightName = getDisplayName(right.row.names, right.row.name, language);
      const comparison = collator.compare(leftName, rightName);

      if (comparison !== 0) {
        return inventorySort === "asc" ? comparison : -comparison;
      }

      return collator.compare(left.row.slug, right.row.slug);
    });
  }, [
    deferredInventorySearch,
    inventoryMasteryFilter,
    inventorySourceRows,
    inventorySort,
    language,
  ]);
  const visibleInventoryRows = useMemo(
    () => inventoryRows.slice(0, visibleInventoryCount),
    [inventoryRows, visibleInventoryCount],
  );
  const hasMoreInventoryRows = visibleInventoryRows.length < inventoryRows.length;

  const pricingRows = useMemo(() => {
    const filteredRows = pricingSourceRows.filter((entry) => {
      if (pricingShowOnSaleOnly && !isEntryOnSale(entry)) {
        return false;
      }

      if (!matchesInventorySearch(entry.row, deferredPricingSearch)) {
        return false;
      }

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
  }, [
    deferredPricingSearch,
    pricingMasteryFilter,
    pricingShowOnSaleOnly,
    saleItemSlugSet,
    saleSetSlugSet,
    setComponentLookup,
    pricingSort,
    pricingSourceRows,
  ]);
  const visiblePricingRows = useMemo(
    () => pricingRows.slice(0, visiblePricingCount),
    [pricingRows, visiblePricingCount],
  );
  const hasMorePricingRows = visiblePricingRows.length < pricingRows.length;

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
  const visibleDucatRows = useMemo(
    () => ducatRows.slice(0, visibleDucatCount),
    [ducatRows, visibleDucatCount],
  );
  const hasMoreDucatRows = visibleDucatRows.length < ducatRows.length;

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

  const autoRefreshItems = useMemo(() => {
    if (activeSection === "pricing") {
      return pricingRows.map(({ row }) => ({
        slug: row.slug,
        name: row.name,
      }));
    }

    if (activeSection === "ducats") {
      return ducatRows.map(({ row }) => ({
        slug: row.slug,
        name: row.name,
      }));
    }

    return [];
  }, [activeSection, ducatRows, pricingRows]);

  useEffect(() => {
    const targetSlugs = new Set(autoRefreshItems.map((item) => item.slug));
    activeTargetSlugsRef.current = targetSlugs;
    cancelAutoPriceJobs(targetSlugs);

    if (activeSection !== "pricing" && activeSection !== "ducats") {
      return;
    }

    if (isBulkRefreshing || isAutoPriceRefreshPaused) {
      return;
    }

    const itemsToRefresh = autoRefreshItems.filter((item) => {
      if (queuedPriceJobsRef.current.has(item.slug) || loadingSlugs.has(item.slug)) {
        return false;
      }

      if (isCooldownActive(priceRequestMetaMap[item.slug])) {
        return false;
      }

      const snapshot = priceMap[item.slug] ?? null;

      return snapshot === null || isPriceSnapshotStale(snapshot);
    });

    if (itemsToRefresh.length === 0) {
      return;
    }

    void Promise.allSettled(
      itemsToRefresh.map((item) =>
        queuePriceRefresh(item, { source: "auto" }),
      ),
    );
  }, [
    activeSection,
    autoRefreshItems,
    loadingSlugs,
    priceMap,
    priceRequestMetaMap,
    isBulkRefreshing,
    isAutoPriceRefreshPaused,
  ]);

  useEffect(() => {
    setIsAutoPriceRefreshPaused(false);
    setIsRefreshAllButtonHovered(false);
  }, [activeSection]);

  const priceRetentionSlugs = useMemo(() => {
    const slugs = new Set(inventory.map((item) => item.slug));

    if (activeSection === "pricing" && pricingShowAssemblableSetsOnly) {
      for (const entry of pricingSourceRows) {
        slugs.add(entry.row.slug);
      }
    }

    return [...slugs].sort();
  }, [
    activeSection,
    inventory,
    pricingShowAssemblableSetsOnly,
    pricingSourceRows,
  ]);

  const priceRetentionSlugsKey = priceRetentionSlugs.join("|");

  useEffect(() => {
    const targetSlugs = new Set(priceRetentionSlugs);

    for (const slug of [...queuedPriceJobsRef.current.keys()]) {
      if (!targetSlugs.has(slug)) {
        cancelPriceJob(slug);
      }
    }

    setPriceMap((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        targetSlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });

    setPriceRequestMetaMap((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        targetSlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });

    setErrors((current) => {
      const nextEntries = Object.entries(current).filter(([slug]) =>
        targetSlugs.has(slug),
      );

      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [priceRetentionSlugsKey]);

  const refreshAllTargets = useMemo(() => {
    if (activeSection === "pricing") {
      return pricingRows;
    }

    if (activeSection === "ducats") {
      return ducatRows;
    }

    return [];
  }, [activeSection, ducatRows, pricingSourceRows]);

  const refreshProgress = useMemo(() => {
    if (refreshAllTargets.length === 0) {
      return null;
    }

    let completed = 0;
    let active = 0;

    for (const { row } of refreshAllTargets) {
      const slug = row.slug;
      const isActiveJob =
        loadingSlugs.has(slug) || queuedPriceJobsRef.current.has(slug);

      if (isActiveJob) {
        active += 1;
        continue;
      }

      const snapshot = priceMap[slug] ?? null;

      if (snapshot !== null && !isPriceSnapshotStale(snapshot)) {
        completed += 1;
      }
    }

    return {
      active,
      completed,
      remaining: Math.max(0, refreshAllTargets.length - completed),
      total: refreshAllTargets.length,
    };
  }, [loadingSlugs, priceMap, queuedPriceJobCount, refreshAllTargets]);

  const filteredMasteryItems = useMemo(() => {
    return primeMasteryCatalogEntries
      .filter((entry) => {
        const { item } = entry;

        if (masteryGroup !== "all" && item.group !== masteryGroup) {
          return false;
        }

        const isMastered = isMasteryEntryMastered(entry, masteryProgress);

        if (masteryStatusFilter === "pending" && isMastered) {
          return false;
        }

        if (masteryStatusFilter === "mastered" && !isMastered) {
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
        const leftMastered = isMasteryEntryMastered(left, masteryProgress) ? 1 : 0;
        const rightMastered = isMasteryEntryMastered(right, masteryProgress) ? 1 : 0;

        if (leftMastered !== rightMastered) {
          return leftMastered - rightMastered;
        }

        return getLocalizedName(left.item.names, left.item.name, language).localeCompare(
          getLocalizedName(right.item.names, right.item.name, language),
          language,
          { numeric: true },
        );
      });
  }, [
    deferredMasterySearch,
    language,
    masteryGroup,
    masteryProgress,
    masteryStatusFilter,
    primeMasteryCatalogEntries,
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
            Math.min(current + SECTION_RENDER_CHUNK_SIZE, filteredMasteryItems.length),
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

  useEffect(() => {
    const target = inventoryLoadMoreRef.current;

    if (
      activeSection !== "inventory" ||
      !target ||
      !hasMoreInventoryRows ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleInventoryCount((current) =>
            Math.min(current + SECTION_RENDER_CHUNK_SIZE, inventoryRows.length),
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
  }, [activeSection, hasMoreInventoryRows, inventoryRows.length]);

  useEffect(() => {
    const target = pricingLoadMoreRef.current;

    if (
      activeSection !== "pricing" ||
      !target ||
      !hasMorePricingRows ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisiblePricingCount((current) =>
            Math.min(current + SECTION_RENDER_CHUNK_SIZE, pricingRows.length),
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
  }, [activeSection, hasMorePricingRows, pricingRows.length]);

  useEffect(() => {
    const target = ducatsLoadMoreRef.current;

    if (
      activeSection !== "ducats" ||
      !target ||
      !hasMoreDucatRows ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleDucatCount((current) =>
            Math.min(current + SECTION_RENDER_CHUNK_SIZE, ducatRows.length),
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
  }, [activeSection, ducatRows.length, hasMoreDucatRows]);

  function addItem(item: MarketItem) {
    if (isPrimeSetName(item.name)) {
      return;
    }

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
    if (!Number.isFinite(quantity)) {
      return;
    }

    if (quantity <= 0) {
      removeItem(slug);
      return;
    }

    const safeQuantity = Math.max(1, Math.floor(quantity));

    setInventory((current) =>
      current.map((item) =>
        item.slug === slug ? { ...item, quantity: safeQuantity } : item,
      ),
    );
  }

  function removeItem(slug: string) {
    clearItemState(slug);
    setInventory((current) => current.filter((item) => item.slug !== slug));
  }

  function clearItemState(slug: string) {
    cancelPriceJob(slug);
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
    setPriceRequestMetaMap((current) => {
      const next = { ...current };
      delete next[slug];
      return next;
    });
    setSaleMarks((current) => {
      const nextItemSlugs = removeSlugFromList(current.itemSlugs, slug);
      const nextSetSlugs = removeSlugFromList(current.setSlugs, slug);
      const nextItemSalePrices = removeRecordValue(current.itemSalePrices, slug);
      const nextSetSalePrices = removeRecordValue(current.setSalePrices, slug);

      if (
        nextItemSlugs === current.itemSlugs &&
        nextSetSlugs === current.setSlugs &&
        nextItemSalePrices === current.itemSalePrices &&
        nextSetSalePrices === current.setSalePrices
      ) {
        return current;
      }

      return {
        itemSlugs: nextItemSlugs,
        setSlugs: nextSetSlugs,
        itemSalePrices: nextItemSalePrices,
        setSalePrices: nextSetSalePrices,
      };
    });
  }

  function appendSoldRecord(
    item: Pick<InventoryDisplayEntry["row"], "slug" | "name" | "names" | "assets">,
    options: {
      type: SaleRecordType;
      quantity: number;
      source: SaleRecordSource;
      unitPrice: number | null;
    },
  ) {
    const normalizedQuantity = Math.max(1, Math.floor(options.quantity));
    const normalizedUnitPrice =
      options.unitPrice === null
        ? null
        : Number.isFinite(options.unitPrice)
          ? Math.max(0, Math.round(options.unitPrice))
          : null;

    setSoldHistory((current) => [
      {
        id: createSaleRecordId(),
        soldAt: new Date().toISOString(),
        type: options.type,
        source: options.source,
        quantity: normalizedQuantity,
        unitPrice: normalizedUnitPrice,
        item: {
          slug: item.slug,
          name: item.name,
          ...(item.names ? { names: item.names } : {}),
          ...(item.assets ? { assets: item.assets } : {}),
        },
      },
      ...current,
    ]);
  }

  function sellOneItem(entry: Pick<InventoryDisplayEntry, "row">) {
    const target = inventory.find((item) => item.slug === entry.row.slug);

    if (!target) {
      return;
    }

    appendSoldRecord(entry.row, {
      type: "item",
      quantity: 1,
      source: "auto",
      unitPrice: entry.row.price?.minSellPrice ?? null,
    });

    if (target.quantity <= 1) {
      removeItem(entry.row.slug);
      return;
    }

    changeQuantity(entry.row.slug, target.quantity - 1);
  }

  function sellAssemblableSet(
    entry: Pick<InventoryDisplayEntry, "row" | "recipeIngredients">,
  ) {
    if (!entry.recipeIngredients || entry.recipeIngredients.length === 0) {
      return;
    }

    const consumption = new Map<string, number>();

    for (const ingredient of entry.recipeIngredients) {
      consumption.set(
        ingredient.slug,
        (consumption.get(ingredient.slug) ?? 0) + ingredient.quantity,
      );
    }

    if (consumption.size === 0) {
      return;
    }

    const inventoryQuantities = new Map(
      inventory.map((item) => [item.slug, item.quantity] as const),
    );

    for (const [slug, requiredQuantity] of consumption) {
      if ((inventoryQuantities.get(slug) ?? 0) < requiredQuantity) {
        return;
      }
    }

    const removedSlugs = new Set<string>();
    const nextInventory = inventory.flatMap((item) => {
      const amount = consumption.get(item.slug) ?? 0;

      if (amount <= 0) {
        return [item];
      }

      const nextQuantity = item.quantity - amount;

      if (nextQuantity <= 0) {
        removedSlugs.add(item.slug);
        return [];
      }

      return [
        {
          ...item,
          quantity: nextQuantity,
        },
      ];
    });

    setInventory(nextInventory);

    appendSoldRecord(entry.row, {
      type: "set",
      quantity: 1,
      source: "auto",
      unitPrice: entry.row.price?.minSellPrice ?? null,
    });

    for (const slug of removedSlugs) {
      clearItemState(slug);
    }
  }

  function cancelAllPriceJobs() {
    for (const slug of [...queuedPriceJobsRef.current.keys()]) {
      cancelPriceJob(slug);
    }
  }

  function toggleSaleMark(entry: InventoryDisplayEntry) {
    const salePrice = entry.row.price?.minSellPrice ?? null;

    if (entry.isAssemblableSet) {
      setSaleMarks((current) => {
        const isMarked = current.setSlugs.includes(entry.row.slug);

        return {
          itemSlugs: current.itemSlugs,
          setSlugs: toggleSlugInList(current.setSlugs, entry.row.slug),
          itemSalePrices: current.itemSalePrices,
          setSalePrices: isMarked
            ? removeRecordValue(current.setSalePrices, entry.row.slug)
            : setRecordValue(current.setSalePrices, entry.row.slug, salePrice),
        };
      });
      return;
    }

    setSaleMarks((current) => {
      const isMarked = current.itemSlugs.includes(entry.row.slug);

      return {
        itemSlugs: toggleSlugInList(current.itemSlugs, entry.row.slug),
        setSlugs: current.setSlugs,
        itemSalePrices: isMarked
          ? removeRecordValue(current.itemSalePrices, entry.row.slug)
          : setRecordValue(current.itemSalePrices, entry.row.slug, salePrice),
        setSalePrices: current.setSalePrices,
      };
    });
  }

  function handleAddSoldRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSaleHistoryFeedback(null);

    const trimmedName = saleFormName.trim();

    if (!trimmedName) {
      setSaleHistoryFeedback({
        tone: "error",
        message: "Укажи название проданной вещи.",
      });
      return;
    }

    const quantityValue = Number(saleFormQuantity);

    if (!Number.isFinite(quantityValue) || quantityValue < 1) {
      setSaleHistoryFeedback({
        tone: "error",
        message: "Количество должно быть целым числом больше нуля.",
      });
      return;
    }

    const quantity = Math.max(1, Math.floor(quantityValue));
    const priceText = saleFormUnitPrice.trim();
    let unitPrice: number | null = null;

    if (priceText.length > 0) {
      const parsedPrice = Number(priceText.replace(",", "."));

      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        setSaleHistoryFeedback({
          tone: "error",
          message: "Цена должна быть числом или оставь поле пустым.",
        });
        return;
      }

      unitPrice = Math.max(0, Math.round(parsedPrice));
    }

    const resolvedItem =
      saleFormType === "set"
        ? resolveCatalogItemLike(primeSetCatalog, primeSetLookup, trimmedName)
        : resolveCatalogItemLike(catalog, catalogImportLookup, trimmedName, {
            includeSets: false,
          });

    const itemSnapshot = resolvedItem
      ? {
          slug: resolvedItem.slug,
          name: resolvedItem.name,
          names: resolvedItem.names,
          assets: resolvedItem.assets,
        }
      : {
          slug: buildManualSaleSlug(trimmedName, saleFormType),
          name: trimmedName,
        };

    appendSoldRecord(itemSnapshot, {
      type: saleFormType,
      quantity,
      source: "manual",
      unitPrice,
    });

    const displayName = resolvedItem
      ? getDisplayName(resolvedItem.names, resolvedItem.name, language)
      : trimmedName;

    setSaleHistoryFeedback({
      tone: "success",
      message: `${saleFormType === "set" ? "Комплект" : "Предмет"} «${displayName}» добавлен в статистику.`,
    });
    setSaleFormName("");
    setSaleFormQuantity("1");
    setSaleFormUnitPrice("");
  }

  function isEntryOnSale(entry: InventoryDisplayEntry) {
    if (entry.isAssemblableSet) {
      return saleSetSlugSet.has(entry.row.slug);
    }

    if (saleItemSlugSet.has(entry.row.slug)) {
      return true;
    }

    const parentSetSlugs = setComponentLookup.get(entry.row.slug);

    if (!parentSetSlugs) {
      return false;
    }

    for (const setSlug of parentSetSlugs) {
      if (saleSetSlugSet.has(setSlug)) {
        return true;
      }
    }

    return false;
  }

  function toggleMastered(itemIds: string | string[]) {
    setMasteryProgress((current) => {
      const targetIds = Array.isArray(itemIds) ? itemIds : [itemIds];
      const next = { ...current };
      const isMarked = targetIds.some((itemId) => !!next[itemId]);

      for (const itemId of targetIds) {
        if (isMarked) {
          delete next[itemId];
        } else {
          next[itemId] = true;
        }
      }

      return next;
    });
  }

  async function handleInventoryImportChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";

    if (!file) {
      return;
    }

    setInventoryImportFeedback(null);

    if (catalogState !== "ready" || catalogImportLookup.size === 0) {
      setInventoryImportFeedback({
        tone: "error",
        message: "Каталог прайм-предметов ещё не загружен. Повтори импорт через пару секунд.",
      });
      return;
    }

    try {
      const raw = JSON.parse(await file.text()) as unknown;

      if (!Array.isArray(raw)) {
        throw new Error("JSON должен быть массивом объектов вида { name, count }.");
      }

      const validEntries = raw.filter(isInventoryImportEntry);
      const invalidCount = raw.length - validEntries.length;

      if (validEntries.length === 0) {
        throw new Error("В файле нет ни одной корректной записи формата { name, count }.");
      }

      const importedItems = new Map<string, InventoryItem>();
      const missingNames: string[] = [];

      for (const entry of validEntries) {
        const normalizedName = normalizeImportName(entry.name);
        const matchedItem = catalogImportLookup.get(normalizedName);
        const quantity = Math.max(1, Math.round(entry.count));

        if (!normalizedName || !matchedItem) {
          missingNames.push(entry.name);
          continue;
        }

        const existing = importedItems.get(matchedItem.slug);

        importedItems.set(matchedItem.slug, {
          slug: matchedItem.slug,
          name: matchedItem.name,
          names: matchedItem.names,
          assets: matchedItem.assets,
          ducats: matchedItem.ducats,
          quantity: existing ? existing.quantity + quantity : quantity,
        });
      }

      if (importedItems.size === 0) {
        throw new Error(
          `Не удалось сопоставить ни одного предмета с каталогом.${summarizeMissingNames(missingNames)}`,
        );
      }

      const importedList = [...importedItems.values()];
      const importedSlugSet = new Set(importedList.map((item) => item.slug));

      setInventory((current) => {
        const currentMap = new Map(current.map((item) => [item.slug, item]));
        const nextImported = importedList.map((item) => ({
          ...(currentMap.get(item.slug) ?? {}),
          ...item,
          quantity: item.quantity,
        }));

        return [
          ...nextImported,
          ...current.filter((item) => !importedSlugSet.has(item.slug)),
        ];
      });

      const invalidSuffix =
        invalidCount > 0 ? ` Пропущено некорректных записей: ${invalidCount}.` : "";

      setInventoryImportFeedback({
        tone: "success",
        message: `Импортировано ${importedList.length} позиций.${invalidSuffix}${summarizeMissingNames(missingNames)}`,
      });
    } catch (error) {
      setInventoryImportFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Не удалось прочитать файл инвентаря.",
      });
    }
  }

  async function handleInventoryImageImportChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";

    if (files.length === 0) {
      return;
    }

    setInventoryImageImportFeedback(null);
    setInventoryImageImportIssues([]);

    if (catalogState !== "ready" || catalogImportLookup.size === 0) {
      setInventoryImageImportFeedback({
        tone: "error",
        message:
          "Каталог прайм-предметов ещё не загружен. Повтори импорт через пару секунд.",
      });
      return;
    }

    setIsInventoryImageImporting(true);

    try {
      const { parseInventoryImageFile } = await import("./lib/inventoryImageParser");
      const importedItems = new Map<string, ImportedInventoryMatch>();
      const unresolvedItems = new Map<string, InventoryImageIssue>();
      const failedFiles = new Set<string>();
      let parsedTileCount = 0;

      for (const [index, file] of files.entries()) {
        setInventoryImageImportFeedback({
          tone: "success",
          message: `Обрабатываю ${index + 1} из ${files.length}: ${file.name}...`,
        });

        try {
          const parsedEntries = await parseInventoryImageFile(file);
          parsedTileCount += parsedEntries.length;

          for (const entry of parsedEntries) {
            const quantity = Math.max(1, Math.round(entry.count));
            const normalizedName = normalizeImportName(entry.name);
            const trimmedName = entry.name.trim();

            if (!normalizedName) {
              const issueKey =
                trimmedName.toLowerCase() || `issue-${unresolvedItems.size}`;
              const existingIssue = unresolvedItems.get(issueKey);

              unresolvedItems.set(issueKey, {
                name: existingIssue?.name ?? (trimmedName || "Неизвестно"),
                count: Math.max(existingIssue?.count ?? 0, quantity),
              });
              continue;
            }

            const matchedItem = resolveCatalogItemLike(
              catalog,
              catalogImportLookup,
              entry.name,
              {
                includeSets: false,
              },
            );

            if (!matchedItem) {
              const existingIssue = unresolvedItems.get(normalizedName);

              unresolvedItems.set(normalizedName, {
                name: existingIssue?.name ?? (trimmedName || normalizedName),
                count: Math.max(existingIssue?.count ?? 0, quantity),
              });
              continue;
            }

            const existing = importedItems.get(matchedItem.slug);

            importedItems.set(matchedItem.slug, {
              item: matchedItem,
              quantity: existing ? Math.max(existing.quantity, quantity) : quantity,
            });
          }
        } catch (error) {
          failedFiles.add(file.name);
        }
      }

      const unresolvedList = [...unresolvedItems.values()].sort((left, right) =>
        normalizeImportName(left.name).localeCompare(normalizeImportName(right.name)),
      );
      setInventoryImageImportIssues(unresolvedList);

      if (importedItems.size === 0) {
        const failedFileNames = [...failedFiles];
        const failedSuffix =
          failedFileNames.length > 0
            ? ` Не удалось прочитать: ${failedFileNames.slice(0, 4).join(", ")}${
                failedFileNames.length > 4 ? ` и ещё ${failedFileNames.length - 4}` : ""
              }.`
            : "";
        const unresolvedSuffix =
          unresolvedList.length > 0
            ? summarizeMissingNames(unresolvedList.map((item) => item.name))
            : "";

        if (failedFiles.size > 0) {
          throw new Error(
            `Не удалось распознать ни одного изображения.${unresolvedSuffix}${failedSuffix}`,
          );
        }

        throw new Error(
          `Не удалось сопоставить ни одного предмета с каталогом.${unresolvedSuffix}${failedSuffix}`,
        );
      }

      const importResult = buildInventoryImageImportResult(
        inventory,
        importedItems,
        inventoryImageImportMode,
      );
      const removedSlugs = importResult.removedItems.map((item) => item.slug);

      for (const slug of removedSlugs) {
        clearItemState(slug);
      }

      setInventory(importResult.items);

      const failedFileNames = [...failedFiles];
      const failedSuffix =
        failedFileNames.length > 0
          ? ` Не удалось прочитать: ${failedFileNames.slice(0, 4).join(", ")}${
              failedFileNames.length > 4 ? ` и ещё ${failedFileNames.length - 4}` : ""
            }.`
          : "";
      const issueSuffix =
        unresolvedList.length > 0 ? ` Спорных строк: ${unresolvedList.length}.` : "";
      const parsedSuffix =
        parsedTileCount > 0 ? ` Распознано плиток: ${parsedTileCount}.` : "";
      const summaryPrefix =
        inventoryImageImportMode === "append"
          ? "Инвентарь дополнен по картинкам"
          : "Инвентарь заменён по картинкам";
      const changeSuffix =
        inventoryImageImportMode === "append"
          ? importResult.addedCount === 0 && importResult.updatedCount === 0
            ? " Инвентарь уже содержит все предметы со скриншотов."
            : ` Добавлено ${importResult.addedCount} новых позиций${
                importResult.updatedCount > 0
                  ? `, обновлено ${importResult.updatedCount} существующих`
                  : ""
              }.`
          : ` Импортировано ${importResult.items.length} позиций. Удалено ${removedSlugs.length} старых позиций.`;

      setInventoryImageImportFeedback({
        tone: "success",
        message: `${summaryPrefix}.${changeSuffix}${parsedSuffix}${issueSuffix}${failedSuffix}`,
      });
    } catch (error) {
      setInventoryImageImportFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Не удалось прочитать изображения инвентаря.",
      });
    } finally {
      setIsInventoryImageImporting(false);
    }
  }

  async function handleMasteryImportChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";

    if (!file) {
      return;
    }

    setMasteryImportFeedback(null);

    try {
      const raw = JSON.parse(await file.text()) as unknown;

      if (!Array.isArray(raw)) {
        throw new Error("JSON должен быть массивом объектов вида { name, isMastery }.");
      }

      const validEntries = raw.filter(isMasteryImportEntry);
      const invalidCount = raw.length - validEntries.length;

      if (validEntries.length === 0) {
        throw new Error(
          "В файле нет ни одной корректной записи формата { name, isMastery }.",
        );
      }

      const masteryItems = await ensureMasteryCatalogLoaded();
      const lookup =
        masteryItems === masteryCatalog && masteryImportLookup.size > 0
          ? masteryImportLookup
          : buildMasteryEntryLookup(groupMasteryCatalogEntries(masteryItems));
      const updates = new Map<string, boolean>();
      const missingNames: string[] = [];

      for (const entry of validEntries) {
        const normalizedName = normalizeImportName(entry.name);
        const matchedEntry = lookup.get(normalizedName);

        if (!normalizedName || !matchedEntry) {
          missingNames.push(entry.name);
          continue;
        }

        for (const itemId of matchedEntry.sourceIds) {
          updates.set(itemId, entry.isMastery);
        }
      }

      if (updates.size === 0) {
        throw new Error(
          `Не удалось сопоставить ни одного mastery-предмета.${summarizeMissingNames(missingNames)}`,
        );
      }

      setMasteryProgress((current) => {
        const next = { ...current };

        for (const [itemId, isMastery] of updates) {
          if (isMastery) {
            next[itemId] = true;
          } else {
            delete next[itemId];
          }
        }

        return next;
      });

      const invalidSuffix =
        invalidCount > 0 ? ` Пропущено некорректных записей: ${invalidCount}.` : "";

      setMasteryImportFeedback({
        tone: "success",
        message: `Обновлено ${updates.size} mastery-предметов.${invalidSuffix}${summarizeMissingNames(missingNames)}`,
      });
    } catch (error) {
      setMasteryImportFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Не удалось прочитать файл освоенных предметов.",
      });
    }
  }

  function handleInventoryExport() {
    const payload = inventory.map((item) => ({
      name: getLocalizedName(item.names, item.name, language),
      count: item.quantity,
    }));

    downloadJsonFile("warframe-inventory", payload);
  }

  async function handleMasteryExport() {
    const masteryItems =
      masteryCatalogEntries.length > 0 ? masteryCatalogEntries : groupMasteryCatalogEntries(await ensureMasteryCatalogLoaded());
    const payload = masteryItems.map((entry) => ({
      name: getLocalizedName(entry.item.names, entry.item.name, language),
      isMastery: isMasteryEntryMastered(entry, masteryProgress),
    }));

    downloadJsonFile("warframe-mastery-progress", payload);
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

  function toggleInventorySort() {
    setInventorySort((current) => {
      if (current === null) {
        return "asc";
      }

      if (current === "asc") {
        return "desc";
      }

      return null;
    });
  }

  function clearMasteryProgress() {
    const confirmed = window.confirm(
      "Очистить все освоенные предметы? Отметки mastery будут сброшены для всего каталога.",
    );

    if (!confirmed) {
      return;
    }

    setMasteryProgress({});
    setMasteryImportFeedback(null);
  }

  function clearInventoryOnly() {
    const confirmed = window.confirm(
      "Очистить весь инвентарь? Все предметы будут удалены из списка, а связанные с ними локальные данные будут сброшены.",
    );

    if (!confirmed) {
      return;
    }

    setInventory([]);
    setInventoryImportFeedback(null);
    setInventoryImageImportFeedback(null);
    setInventoryImageImportIssues([]);
  }

  function clearAllData() {
    const confirmed = window.confirm(
      "Очистить весь инвентарь, историю продаж, прогресс освоения, фильтры, настройки языка и локальные кеши приложения?",
    );

    if (!confirmed) {
      return;
    }

    removeFromStorageByPrefix(APP_STORAGE_PREFIX);
    for (const slug of [...queuedPriceJobsRef.current.keys()]) {
      cancelPriceJob(slug);
    }
    queuedPriceSlugsRef.current = [];
    activePriceRequestsRef.current = 0;
    activeTargetSlugsRef.current = new Set();
    setInventory([]);
    setInventorySearch("");
    setLanguage("ru");
    setMarketUsername("");
    setMarketUsernameInput("");
    setWikiPageCache({});
    setWikiPageState("idle");
    setWikiPageError(null);
    setInventoryImportFeedback(null);
    setInventoryImageImportFeedback(null);
    setInventoryImageImportIssues([]);
    setMasteryImportFeedback(null);
    setSaleHistoryFeedback(null);
    setPriceMap({});
    setPriceRequestMetaMap({});
    setSaleMarks({
      itemSlugs: [],
      setSlugs: [],
      itemSalePrices: {},
      setSalePrices: {},
    });
    setSoldHistory([]);
    setLoadingSlugs(new Set());
    setErrors({});
    setIsBulkRefreshing(false);
    setIsAutoPriceRefreshPaused(false);
    setIsRefreshAllButtonHovered(false);
    setIsInventoryImageImporting(false);
    setInventoryMasteryFilter("all");
    setPricingMasteryFilter("mastered");
    setDucatsMasteryFilter("mastered");
    setPricingSort(null);
    setDucatSort({
      key: "ducatsPerPlatinum",
      direction: "desc",
    });
    setMasteryProgress({});
    setMasterySearch("");
    setMasteryGroup("all");
    setMasteryStatusFilter("pending");
    setSaleHistorySearch("");
    setSaleHistoryTypeFilter("all");
    setSaleFormName("");
    setSaleFormType("item");
    setSaleFormQuantity("1");
    setSaleFormUnitPrice("");
    setVisibleMasteryCount(SECTION_RENDER_CHUNK_SIZE);
    setVisibleInventoryCount(SECTION_RENDER_CHUNK_SIZE);
    setVisiblePricingCount(SECTION_RENDER_CHUNK_SIZE);
    setVisibleDucatCount(SECTION_RENDER_CHUNK_SIZE);
    setInventoryShowAssemblableSetsOnly(false);
    setInventoryShowMissingSetRequirementsOnly(false);
    setPricingShowAssemblableSetsOnly(false);
    setPricingSearch("");
    setPricingShowOnSaleOnly(false);
  }

  const isAnyPriceRefreshActive =
    isBulkRefreshing ||
    loadingSlugs.size > 0 ||
    queuedPriceJobCount > 0 ||
    activePriceRequestsRef.current > 0;
  const isPriceRefreshSection =
    activeSection === "pricing" || activeSection === "ducats";
  const refreshAllButtonActionLabel = isAnyPriceRefreshActive
    ? "Отменить все запросы"
    : "Обновить все цены";
  const refreshAllButtonLabel = isAnyPriceRefreshActive
    ? isRefreshAllButtonHovered
      ? refreshAllButtonActionLabel
      : "Обновляю цены..."
    : refreshAllButtonActionLabel;
  const refreshAllButtonClassName = `primary-button${
    isAnyPriceRefreshActive && isRefreshAllButtonHovered ? " is-canceling" : ""
  }`;

  async function refreshAll(force = false) {
    if (
      refreshAllTargets.length === 0 ||
      isBulkRefreshing ||
      activePriceRequestsRef.current > 0 ||
      queuedPriceJobsRef.current.size > 0
    ) {
      return;
    }

    setIsAutoPriceRefreshPaused(false);
    setIsBulkRefreshing(true);

    try {
      await Promise.allSettled(
        refreshAllTargets.map(({ row }) =>
          queuePriceRefresh(row, { force, source: "manual" }),
        ),
      );
    } finally {
      setIsBulkRefreshing(false);
    }
  }

  function cancelAllPriceRefreshes() {
    setIsAutoPriceRefreshPaused(true);

    for (const slug of [...queuedPriceJobsRef.current.keys()]) {
      cancelPriceJob(slug);
    }
  }

  return (
    <div className="app-shell">
      <main className="page app-layout">
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-brand-mark" aria-hidden="true">
              <FadeInImage src="/app-icon.svg" alt="" />
            </div>
            <span className="sidebar-kicker">Разделы</span>
            <strong>Prime Tracker</strong>
          </div>

          <nav className="sidebar-nav" aria-label="Разделы приложения">
            {APP_SECTIONS.map((section) => (
              <button
                key={section.id}
                className={`sidebar-tab${activeSection === section.id ? " is-active" : ""}`}
                type="button"
                disabled={Boolean(section.disabled)}
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
              {activeSection === "statistics" && (
                <div className="topbar-pill">{soldHistory.length} записей</div>
              )}
              {isPriceRefreshSection && (
                <button
                  className={refreshAllButtonClassName}
                  type="button"
                  onClick={() => {
                    if (isAnyPriceRefreshActive) {
                      cancelAllPriceRefreshes();
                      return;
                    }

                    void refreshAll(true);
                  }}
                  onMouseEnter={() => setIsRefreshAllButtonHovered(true)}
                  onMouseLeave={() => setIsRefreshAllButtonHovered(false)}
                  disabled={refreshAllTargets.length === 0}
                  aria-label={refreshAllButtonActionLabel}
                  title={refreshAllButtonActionLabel}
                >
                  {refreshAllButtonLabel}
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
                    <p>
                      Нажми на карточку, чтобы добавить её в свой инвентарь. Поиск
                      сверху фильтрует и список добавления, и инвентарь ниже.
                    </p>
                  </div>
                </div>

                <div className="search-block">
                  <input
                    id="inventory-search"
                    className="search-input"
                    value={inventorySearch}
                    onChange={(event) => setInventorySearch(event.target.value)}
                    placeholder="Поиск по каталогу и инвентарю"
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
                  {inventorySearch.trim().length >= 2 &&
                    suggestions.length === 0 &&
                    catalogState === "ready" && (
                      <p className="state-message">Ничего не найдено.</p>
                    )}
                </div>

                {suggestions.length > 0 && (
                  <div className="item-grid search-suggestions-grid">
                    {suggestions.map((item) => {
                      const displayName = getDisplayName(
                        item.names,
                        item.name,
                        language,
                      );

                      return (
                        <button
                          key={item.slug}
                          className="item-card item-card-button"
                          type="button"
                          onClick={() => addItem(item)}
                        >
                          <ItemPreview item={item} language={language} />
                          <div className="item-card-body item-card-body-fixed">
                            <strong className="item-card-title" title={displayName}>
                              {displayName}
                            </strong>
                            <span className="item-card-slug" title={item.slug}>
                              {item.slug}
                            </span>
                          </div>
                        </button>
                      );
                    })}
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
                          ? isCraftableSetInventoryView
                            ? wikiPageState === "loading"
                              ? "Ищу составы в вики..."
                              : wikiPageState === "error"
                                ? "Вики сейчас недоступна"
                                : "Пока нет доступных комплектов"
                            : isMissingSetInventoryView
                              ? wikiPageState === "loading"
                                ? "Ищу составы в вики..."
                                : wikiPageState === "error"
                                  ? "Вики сейчас недоступна"
                                  : "Пока нет комплектов, которым чего-то не хватает"
                              : "Пока пусто"
                          : inventoryMasteryFilter === "all" &&
                              deferredInventorySearch.length === 0
                            ? isCraftableSetInventoryView
                              ? `${inventoryRows.length} комплектов можно собрать`
                              : isMissingSetInventoryView
                                ? `${inventoryRows.length} комплектов с недостающими частями`
                                : `${inventoryRows.length} позиций в коллекции`
                            : isCraftableSetInventoryView
                              ? `${inventoryRows.length} из ${inventorySourceRows.length} комплектов`
                              : isMissingSetInventoryView
                                ? `${inventoryRows.length} из ${inventorySourceRows.length} комплектов`
                                : `${inventoryRows.length} из ${inventorySourceRows.length} позиций`}
                      </p>
                    </div>
                  </div>
                  <span className="table-note">
                    {isCraftableSetInventoryView
                      ? wikiPageState === "loading"
                        ? "Загружаю составы из вики..."
                        : wikiPageState === "error" && wikiPageError
                          ? wikiPageError
                          : "Комплекты считаются автоматически по предметам из инвентаря."
                      : isMissingSetInventoryView
                        ? wikiPageState === "loading"
                          ? "Загружаю составы из вики..."
                          : wikiPageState === "error" && wikiPageError
                            ? wikiPageError
                            : "Показываю, каких предметов и сколько не хватает до полного комплекта."
                        : "Управляй количеством здесь, цены смотри во вкладке стоимости."}
                  </span>
                </div>

                <div className="inventory-tools">
                  <div className="inventory-tools-row">
                    <div className="inventory-switches">
                      <button
                        className={`inventory-switch${isCraftableSetInventoryView ? " is-active" : ""}`}
                        type="button"
                        onClick={() => {
                          setInventoryShowAssemblableSetsOnly((current) => !current);
                          setInventoryShowMissingSetRequirementsOnly(false);
                        }}
                        aria-pressed={isCraftableSetInventoryView}
                      >
                        <span className="inventory-switch-track" aria-hidden="true">
                          <span className="inventory-switch-thumb" />
                        </span>
                        <span className="inventory-switch-copy">
                          <strong>Только комплекты</strong>
                          <span>Показывать комплекты, которые уже можно собрать</span>
                        </span>
                      </button>
                      <button
                        className={`inventory-switch${isMissingSetInventoryView ? " is-active" : ""}`}
                        type="button"
                        onClick={() => {
                          setInventoryShowMissingSetRequirementsOnly((current) => !current);
                          setInventoryShowAssemblableSetsOnly(false);
                        }}
                        aria-pressed={isMissingSetInventoryView}
                      >
                        <span className="inventory-switch-track" aria-hidden="true">
                          <span className="inventory-switch-thumb" />
                        </span>
                        <span className="inventory-switch-copy">
                          <strong>Не хватает до комплекта</strong>
                          <span>Показывать, каких предметов и сколько нужно добрать</span>
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="pricing-toolbar inventory-toolbar">
                    <div className="inventory-toolbar-row">
                      <div
                        className="filter-row pricing-filter-row"
                        aria-label="Фильтр инвентаря по освоению"
                      >
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
                      <button
                        className={`inventory-sort-control${inventorySort ? " is-active" : ""}`}
                        type="button"
                        onClick={toggleInventorySort}
                        aria-pressed={inventorySort !== null}
                        aria-label="Сортировка инвентаря по названию"
                        title="Сортировка инвентаря по названию"
                      >
                        <span className="inventory-sort-control-icon" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                        <span className="inventory-sort-control-copy">
                          <strong>Название</strong>
                          <span>
                            {inventorySort === "asc"
                              ? "A → Я"
                              : inventorySort === "desc"
                                ? "Я → A"
                                : "↕"}
                          </span>
                        </span>
                      </button>
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
                </div>

                {inventoryRows.length === 0 ? (
                  <div className="empty-state">
                    <h3>
                      {inventorySourceRows.length === 0
                        ? rows.length === 0
                          ? "Инвентарь пуст"
                          : isCraftableSetInventoryView
                            ? wikiPageState === "loading"
                              ? "Загружаю составы..."
                              : wikiPageState === "error"
                                ? "Не удалось загрузить составы"
                                : "Комплекты не найдены"
                            : isMissingSetInventoryView
                              ? wikiPageState === "loading"
                                ? "Загружаю составы..."
                                : wikiPageState === "error"
                                  ? "Не удалось загрузить составы"
                                  : "Пока нет комплектов, которым чего-то не хватает"
                              : "Инвентарь пуст"
                        : "Ничего не найдено"}
                    </h3>
                    <p>
                      {inventorySourceRows.length === 0
                        ? rows.length === 0
                          ? "Добавь предметы через поиск выше."
                          : isCraftableSetInventoryView
                            ? wikiPageState === "loading"
                              ? "Сверяю инвентарь с вики и ищу подходящие рецепты."
                              : wikiPageState === "error"
                                ? "Проверь подключение к вики или попробуй позже."
                                : "Нужно собрать предметы из рецепта на вики, чтобы появился комплект."
                            : isMissingSetInventoryView
                              ? wikiPageState === "loading"
                                ? "Сверяю инвентарь с вики и ищу подходящие рецепты."
                                : wikiPageState === "error"
                                  ? "Проверь подключение к вики или попробуй позже."
                                  : "Из текущего инвентаря все найденные комплекты уже можно собрать."
                              : "Добавь предметы через поиск выше."
                        : deferredInventorySearch.length > 0
                          ? isCraftableSetInventoryView || isMissingSetInventoryView
                            ? "Поиск по комплектам не дал результатов."
                            : "Поиск по инвентарю не дал результатов."
                          : isCraftableSetInventoryView || isMissingSetInventoryView
                            ? "Фильтр по освоению не оставил ни одного комплекта."
                            : "Фильтр по освоению не оставил ни одной позиции."}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="progressive-results-meta">
                      <span>
                        Показано {visibleInventoryRows.length} из {inventoryRows.length}
                      </span>
                    </div>

                    <div className="item-grid owned-grid">
                      {visibleInventoryRows.map((entry) => {
                        const { row } = entry;
                        const displayName = getDisplayName(
                          row.names,
                          row.name,
                          language,
                        );

                        return (
                          <article
                            key={`${
                              entry.isAssemblableSet
                                ? "set"
                                : entry.isMissingSet
                                  ? "missing-set"
                                  : "item"
                            }-${row.slug}`}
                            className={`item-card owned-card${entry.isAssemblableSet ? " assemblable-set-card" : ""}${entry.isMissingSet ? " missing-set-card" : ""}`}
                          >
                            <ItemPreview item={row} language={language} />

                            <div className="item-card-body item-card-body-fixed">
                              <strong className="item-card-title" title={displayName}>
                                {displayName}
                              </strong>
                              <span className="item-card-slug" title={row.slug}>
                                {row.slug}
                              </span>
                            </div>

                            <div className="owned-card-footer">
                              {entry.isAssemblableSet ? (
                                <div className="assemblable-set-footer">
                                  <span className="assemblable-set-badge">Комплект</span>
                                  <div className="assemblable-set-stats">
                                    <strong>Можно собрать: {row.quantity}</strong>
                                    <span title={entry.recipeSummary}>{entry.recipeSummary}</span>
                                  </div>
                                </div>
                              ) : entry.isMissingSet ? (
                                <div className="assemblable-set-footer is-missing">
                                  <span className="assemblable-set-badge is-missing">Не хватает</span>
                                  <div className="assemblable-set-stats">
                                    <strong>
                                      Не хватает: {entry.missingPartCount ?? 0} шт.
                                    </strong>
                                    <span title={entry.missingSummary ?? entry.recipeSummary ?? ""}>
                                      {entry.missingSummary ?? entry.recipeSummary}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button
                                    className="quantity-stepper-button"
                                    type="button"
                                    onClick={() => changeQuantity(row.slug, row.quantity - 1)}
                                    aria-label="Уменьшить количество"
                                    title="Уменьшить количество"
                                  >
                                    -
                                  </button>
                                  <span className="quantity-stepper-value" aria-live="polite">
                                    {row.quantity}
                                  </span>
                                  <button
                                    className="quantity-stepper-button"
                                    type="button"
                                    onClick={() => changeQuantity(row.slug, row.quantity + 1)}
                                    aria-label="Увеличить количество"
                                    title="Увеличить количество"
                                  >
                                    +
                                  </button>
                                </>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>

                    {hasMoreInventoryRows && (
                      <div className="progressive-load-more">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() =>
                            setVisibleInventoryCount((current) =>
                              Math.min(
                                current + SECTION_RENDER_CHUNK_SIZE,
                                inventoryRows.length,
                              ),
                            )
                          }
                        >
                          Показать еще
                        </button>
                        <div
                          ref={inventoryLoadMoreRef}
                          className="progressive-load-sentinel"
                          aria-hidden="true"
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          ) : activeSection === "statistics" ? (
            <>
              <section className="summary-grid">
                <article className="summary-card">
                  <span>Записей</span>
                  <strong>{saleHistorySummary.records}</strong>
                </article>
                <article className="summary-card">
                  <span>Штук</span>
                  <strong>{saleHistorySummary.units}</strong>
                </article>
                <article className="summary-card">
                  <span>Комплектов</span>
                  <strong>{saleHistorySummary.setUnits}</strong>
                </article>
                <article className="summary-card">
                  <span>Платина</span>
                  <strong>{formatPlatinum(saleHistorySummary.revenue)}</strong>
                </article>
              </section>

              <section className="panel statistics-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>Добавить продажу</h2>
                    <p>
                      Запись сохраняется отдельно от инвентаря и не влияет на количество
                      предметов.
                    </p>
                  </div>
                  <span className="table-note">
                    Можно добавить вручную любой предмет или комплект. Цена за шт. не обязательна,
                    но без неё запись не попадёт в сумму.
                  </span>
                </div>

                <form className="sale-form" onSubmit={handleAddSoldRecord}>
                  <div className="sale-form-grid">
                    <label className="sale-form-field sale-form-field-wide">
                      <span>Название</span>
                      <input
                        className="search-input sale-form-input"
                        value={saleFormName}
                        onChange={(event) => setSaleFormName(event.target.value)}
                        placeholder="Wukong Prime Set"
                        autoComplete="off"
                      />
                    </label>

                    <label className="sale-form-field">
                      <span>Тип</span>
                      <select
                        className="search-input sale-form-input sale-form-select"
                        value={saleFormType}
                        onChange={(event) =>
                          setSaleFormType(event.target.value as SaleRecordType)
                        }
                      >
                        <option value="item">Предмет</option>
                        <option value="set">Комплект</option>
                      </select>
                    </label>

                    <label className="sale-form-field">
                      <span>Количество</span>
                      <input
                        className="search-input sale-form-input"
                        type="number"
                        min="1"
                        step="1"
                        value={saleFormQuantity}
                        onChange={(event) => setSaleFormQuantity(event.target.value)}
                        inputMode="numeric"
                      />
                    </label>

                    <label className="sale-form-field">
                      <span>Цена за шт.</span>
                      <input
                        className="search-input sale-form-input"
                        type="number"
                        min="0"
                        step="1"
                        value={saleFormUnitPrice}
                        onChange={(event) => setSaleFormUnitPrice(event.target.value)}
                        placeholder="Необязательно"
                        inputMode="numeric"
                      />
                    </label>
                  </div>

                  <div className="sale-form-actions">
                    <button className="primary-button" type="submit">
                      Добавить в статистику
                    </button>
                    <span className="table-note sale-form-note">
                      {saleFormResolvedItem
                        ? `Найдено в каталоге: ${saleFormResolvedDisplayName}.`
                        : saleFormName.trim().length > 0
                          ? "Запись будет сохранена как ручная."
                          : "Можно добавить запись вручную без сопоставления с каталогом."}
                    </span>
                  </div>

                  {saleHistoryFeedback && (
                    <p
                      className={`settings-status${saleHistoryFeedback.tone === "error" ? " is-error" : " is-success"}`}
                    >
                      {saleHistoryFeedback.message}
                    </p>
                  )}

                  {saleFormResolvedItem && (
                    <div className="sale-form-preview">
                      <ItemPreview item={saleFormResolvedItem} language={language} />
                      <div className="sale-form-preview-copy">
                        <strong>{saleFormResolvedDisplayName}</strong>
                        <span>
                          {saleFormType === "set" ? "Комплект" : "Предмет"} будет сохранён
                          как {saleFormResolvedItem.slug}
                        </span>
                      </div>
                    </div>
                  )}
                </form>
              </section>

              <section className="panel statistics-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>История продаж</h2>
                    <p>
                      {filteredSoldHistory.length === 0
                        ? soldHistory.length === 0
                          ? "Пока нет записей"
                          : "Ничего не найдено"
                        : `${filteredSoldHistory.length} из ${soldHistory.length} записей`}
                    </p>
                  </div>
                  <span className="table-note">
                    Поиск работает по названию, slug, типу записи и источнику.
                  </span>
                </div>

                <div className="inventory-tools statistics-tools">
                  <div className="inventory-tools-row">
                    <div className="inventory-search-field">
                      <input
                        className="search-input"
                        value={saleHistorySearch}
                        onChange={(event) => setSaleHistorySearch(event.target.value)}
                        placeholder="Поиск по проданным вещам"
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  <div className="filter-row pricing-filter-row" aria-label="Фильтр истории продаж">
                    {SALE_HISTORY_TYPE_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        className={`filter-chip${saleHistoryTypeFilter === filter.id ? " is-active" : ""}`}
                        type="button"
                        onClick={() => setSaleHistoryTypeFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredSoldHistory.length === 0 ? (
                  <div className="empty-state">
                    <h3>
                      {soldHistory.length === 0
                        ? "История продаж пуста"
                        : "Ничего не найдено"}
                    </h3>
                    <p>
                      {soldHistory.length === 0
                        ? "Добавь первую продажу вручную или списывай предметы кнопкой «Продано» в таблицах цен."
                        : "Сбрось фильтр или поменяй запрос, чтобы увидеть нужную запись."}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="progressive-results-meta">
                      <span>
                        Показано {filteredSoldHistory.length} из {soldHistory.length}
                      </span>
                      <span>
                        {saleHistorySummary.manualRecords} ручных, {saleHistorySummary.autoRecords} автоматически
                      </span>
                    </div>

                    <div className="table-wrap">
                      <table className="inventory-table statistics-table">
                        <thead>
                          <tr>
                            <th>Продано</th>
                            <th>Тип</th>
                            <th>Кол-во</th>
                            <th>Цена за шт.</th>
                            <th>Сумма</th>
                            <th>Источник</th>
                            <th>Дата</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredSoldHistory.map((record) => {
                            const displayName = getDisplayName(
                              record.item.names,
                              record.item.name,
                              language,
                            );
                            const totalPrice =
                              record.unitPrice !== null
                                ? record.unitPrice * record.quantity
                                : null;

                            return (
                              <tr
                                key={record.id}
                                className={record.source === "manual" ? "is-manual-sale" : "is-auto-sale"}
                              >
                                <td>
                                  <div className="item-name-row">
                                    <ItemTablePreview item={record.item} language={language} />
                                    <div className="item-name-cell">
                                      <strong>{displayName}</strong>
                                      <span>{record.item.slug}</span>
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <span className="sale-record-badge">
                                    {formatSaleRecordTypeLabel(record.type)}
                                  </span>
                                </td>
                                <td>{record.quantity}</td>
                                <td>{formatPlatinum(record.unitPrice)}</td>
                                <td>{formatPlatinum(totalPrice)}</td>
                                <td>
                                  <span className="sale-record-badge is-muted">
                                    {formatSaleRecordSourceLabel(record.source)}
                                  </span>
                                </td>
                                <td>{formatTimestamp(record.soldAt)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            </>
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
                    <h2>
                      {pricingShowAssemblableSetsOnly
                        ? "Стоимость комплектов"
                        : "Стоимость прайм предметов"}
                    </h2>
                    <p>
                      {pricingRows.length === 0
                        ? pricingShowAssemblableSetsOnly
                          ? pricingSourceRows.length === 0
                            ? "Комплекты не найдены"
                            : "Фильтр не оставил ни одного комплекта."
                          : rows.length === 0
                            ? "Пусто"
                            : "Фильтр не оставил ни одной позиции."
                        : `${pricingRows.length} позиций`}
                    </p>
                  </div>
                  <span className="table-note">
                    {pricingShowAssemblableSetsOnly
                      ? "Показываю комплекты, которые можно собрать из текущего инвентаря. Кнопка «На продаже» помечает комплект и его компоненты, а «Продано» списывает компоненты комплекта. Цена берётся по комплекту на warframe.market и не учитывает твои лоты, если указан ник."
                      : "Продажа = минимальная цена у продавцов, но твои лоты исключаются из расчёта, если указан ник. Покупка = лучшая ставка покупателя. Кнопка «На продаже» помечает предмет для отслеживания."}
                  </span>
                </div>

                <div className="inventory-tools pricing-tools">
                  <div className="inventory-tools-row">
                    <div className="inventory-search-field">
                      <input
                        id="pricing-owned-search"
                        className="search-input"
                        value={pricingSearch}
                        onChange={(event) => setPricingSearch(event.target.value)}
                        placeholder={
                          pricingShowAssemblableSetsOnly
                            ? "Поиск по комплектам"
                            : "Поиск по прайм-предметам"
                        }
                        autoComplete="off"
                      />
                    </div>
                    <div className="inventory-switches">
                      <button
                        className={`inventory-switch pricing-switch${pricingShowOnSaleOnly ? " is-active" : ""}`}
                        type="button"
                        onClick={() =>
                          setPricingShowOnSaleOnly((current) => !current)
                        }
                        aria-pressed={pricingShowOnSaleOnly}
                      >
                        <span className="inventory-switch-track" aria-hidden="true">
                          <span className="inventory-switch-thumb" />
                        </span>
                        <span className="inventory-switch-copy">
                          <strong>Только на продаже</strong>
                          <span>Показывать только позиции с меткой продажи</span>
                        </span>
                      </button>
                    </div>
                  </div>
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
                  <button
                    className={`inventory-switch pricing-switch${pricingShowAssemblableSetsOnly ? " is-active" : ""}`}
                    type="button"
                    onClick={() =>
                      setPricingShowAssemblableSetsOnly((current) => !current)
                    }
                    aria-pressed={pricingShowAssemblableSetsOnly}
                  >
                    <span className="inventory-switch-track" aria-hidden="true">
                      <span className="inventory-switch-thumb" />
                    </span>
                    <span className="inventory-switch-copy">
                      <strong>Комплекты</strong>
                      <span>Показывать цены по собранным сетам</span>
                    </span>
                  </button>
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

                {refreshProgress && (
                  <RefreshProgressBar
                    label="Прогресс обновления цен"
                    completed={refreshProgress.completed}
                    total={refreshProgress.total}
                    remaining={refreshProgress.remaining}
                    active={refreshProgress.active}
                  />
                )}

                {pricingRows.length === 0 ? (
                  <div className="empty-state">
                    <h3>
                      {pricingShowAssemblableSetsOnly
                        ? pricingSourceRows.length === 0
                          ? "Нет комплектов для оценки"
                          : "Фильтр не оставил комплектов"
                        : rows.length === 0
                          ? "Нет предметов для оценки"
                          : "Фильтр не оставил ни одной позиции"}
                    </h3>
                    <p>
                      {pricingShowAssemblableSetsOnly
                        ? pricingSourceRows.length === 0
                          ? rows.length === 0
                            ? "Сначала добавь предметы во вкладке инвентаря."
                            : "Из текущего инвентаря пока нельзя собрать ни один комплект."
                          : "Фильтр не оставил ни одного комплекта."
                        : rows.length === 0
                          ? "Сначала добавь их во вкладке инвентаря."
                          : "Фильтр не оставил ни одной позиции."}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="progressive-results-meta">
                      <span>
                        Показано {visiblePricingRows.length} из {pricingRows.length}
                      </span>
                    </div>

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
                            <th>Цена при выставлении</th>
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
                          {visiblePricingRows.map((entry) => {
                            const { row, total, masteryStatus } = entry;
                            const isAssemblableSetRow = !!entry.isAssemblableSet;
                            const isOnSale = isEntryOnSale(entry);
                            const isDirectSaleMarked = isAssemblableSetRow
                              ? saleSetSlugSet.has(row.slug)
                              : saleItemSlugSet.has(row.slug);
                            const salePriceRecord = isAssemblableSetRow
                              ? saleMarks.setSalePrices
                              : saleMarks.itemSalePrices;
                            const currentMinSellPrice = row.price?.minSellPrice ?? null;
                            const salePriceAtMark = salePriceRecord[row.slug] ?? null;
                            const isSalePriceEmpty = !isDirectSaleMarked || salePriceAtMark === null;
                            const isSalePriceBelowMin =
                              isDirectSaleMarked &&
                              salePriceAtMark !== null &&
                              currentMinSellPrice !== null &&
                              salePriceAtMark < currentMinSellPrice;
                            const isSalePriceAboveMin =
                              isDirectSaleMarked &&
                              salePriceAtMark !== null &&
                              currentMinSellPrice !== null &&
                              salePriceAtMark > currentMinSellPrice;
                            const saleButtonLabel = isAssemblableSetRow
                              ? isOnSale
                                ? "Снять комплект с продажи"
                                : "Пометить комплект на продаже"
                              : saleItemSlugSet.has(row.slug)
                                ? "Снять с продажи"
                                : isOnSale
                                  ? "На продаже через комплект"
                                  : "Пометить на продаже";
                            const canSellRow =
                              !isAssemblableSetRow ||
                              (entry.recipeIngredients?.length ?? 0) > 0;
                            const handleSellRow = isAssemblableSetRow
                              ? () => sellAssemblableSet(entry)
                              : () => sellOneItem(entry);

                            return (
                              <tr key={row.slug} className={isOnSale ? "is-on-sale" : ""}>
                                <td>
                                  <div className="item-name-row">
                                    <ItemTablePreview item={row} language={language} />
                                    <div className="item-name-cell">
                                      <strong>{getDisplayName(row.names, row.name, language)}</strong>
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
                                <td>{formatPlatinum(currentMinSellPrice)}</td>
                                <td>
                                  <div
                                    className={`sale-price-cell${isSalePriceEmpty ? " is-empty" : ""}${isSalePriceBelowMin ? " is-below-min" : ""}${isSalePriceAboveMin ? " is-above-min" : ""}`}
                                  >
                                    {salePriceAtMark !== null
                                      ? formatPlatinum(salePriceAtMark)
                                      : "—"}
                                  </div>
                                </td>
                                <td>{formatPlatinum(total)}</td>
                                <td>{formatTimestamp(row.price?.updatedAt ?? null)}</td>
                                <td>
                                  <div className="row-actions">
                                    <button
                                      className={`ghost-button icon-button sale-icon-button${isOnSale ? " is-active" : ""}`}
                                      type="button"
                                      onClick={() => toggleSaleMark(entry)}
                                      aria-pressed={isOnSale}
                                      aria-label={saleButtonLabel}
                                      title={saleButtonLabel}
                                    >
                                      <SaleIcon />
                                    </button>
                                    <button
                                      className="ghost-button icon-button sold-icon-button"
                                      type="button"
                                      onClick={handleSellRow}
                                      disabled={!canSellRow}
                                      aria-label={
                                        isAssemblableSetRow
                                          ? "Отметить комплект как проданный"
                                          : "Отметить одну штуку как проданную"
                                      }
                                      title={
                                        isAssemblableSetRow
                                          ? "Продано: списать компоненты комплекта"
                                          : "Продано: убрать 1 штуку"
                                      }
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

                    {hasMorePricingRows && (
                      <div className="progressive-load-more">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() =>
                            setVisiblePricingCount((current) =>
                              Math.min(
                                current + SECTION_RENDER_CHUNK_SIZE,
                                pricingRows.length,
                              ),
                            )
                          }
                        >
                          Показать еще
                        </button>
                        <div
                          ref={pricingLoadMoreRef}
                          className="progressive-load-sentinel"
                          aria-hidden="true"
                        />
                      </div>
                    )}
                  </>
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

                {refreshProgress && (
                  <RefreshProgressBar
                    label="Прогресс обновления цен"
                    completed={refreshProgress.completed}
                    total={refreshProgress.total}
                    remaining={refreshProgress.remaining}
                    active={refreshProgress.active}
                  />
                )}

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
                  <>
                    <div className="progressive-results-meta">
                      <span>
                        Показано {visibleDucatRows.length} из {ducatRows.length}
                      </span>
                    </div>

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
                          {visibleDucatRows.map(
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
                                          {getDisplayName(row.names, row.name, language)}
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
                                      onClick={() => sellOneItem({ row })}
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

                    {hasMoreDucatRows && (
                      <div className="progressive-load-more">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() =>
                            setVisibleDucatCount((current) =>
                              Math.min(
                                current + SECTION_RENDER_CHUNK_SIZE,
                                ducatRows.length,
                              ),
                            )
                          }
                        >
                          Показать еще
                        </button>
                        <div
                          ref={ducatsLoadMoreRef}
                          className="progressive-load-sentinel"
                          aria-hidden="true"
                        />
                      </div>
                    )}
                  </>
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
                    <h2>Каталог Prime mastery-предметов</h2>
                    <p>
                      Здесь отображаются только Prime-предметы. Прогресс
                      сохраняется локально в браузере.
                    </p>
                  </div>
                  <div className="section-heading-actions">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => void ensureMasteryCatalogLoaded(true)}
                      disabled={masteryCatalogState === "loading"}
                    >
                      {masteryCatalogState === "loading"
                        ? "Обновляю данные..."
                        : "Обновить данные"}
                    </button>
                    <span className="table-note">
                      Если в источнике появились новые предметы, обнови каталог вручную.
                    </span>
                  </div>
                </div>

                <div className="mastery-toolbar">
                  <input
                    className="search-input"
                    value={masterySearch}
                    onChange={(event) => setMasterySearch(event.target.value)}
                    placeholder="Carrier Prime, Burston Prime, Lex Prime..."
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
                </div>

                <div className="filter-row" aria-label="Фильтр по категориям mastery">
                  {MASTERY_GROUP_FILTERS.map((group) => {
                    const stats =
                      group.id === "all" ? masteryTotals : masteryGroupStats[group.id];

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
                    <p>Подтягиваю список всех Prime-предметов для освоения.</p>
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
                      {visibleMasteryItems.map((entry) => {
                        const { item, sourceIds } = entry;
                        const isMastered = isMasteryEntryMastered(entry, masteryProgress);
                        const displayName = getDisplayName(item.names, item.name, language);

                        return (
                          <article
                            key={item.id}
                            className={`item-card mastery-card${isMastered ? " is-mastered" : ""}`}
                          >
                            <MasteryItemPreview item={item} language={language} />

                            <div className="item-card-body mastery-card-body">
                              <MasteryCardTitle title={displayName} />
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
                                onClick={() => toggleMastered(sourceIds)}
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
                                current + SECTION_RENDER_CHUNK_SIZE,
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
            <section className="settings-panel">
              <div className="settings-groups">
                <section className="settings-group">
                  <div className="settings-group-header">
                    <h2>Интерфейс</h2>
                    <p>Базовые параметры отображения данных во всех вкладках приложения.</p>
                  </div>

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
                        <strong>Имя пользователя на warframe.market</strong>
                        <p>
                          Используется, чтобы не учитывать твои собственные лоты в
                          минимальной продаже и точнее подсвечивать цену при выставлении.
                        </p>
                        <label className="settings-field" htmlFor="market-username">
                          <span>Ник на сайте</span>
                          <input
                            id="market-username"
                            className="search-input settings-text-input"
                            type="text"
                            value={marketUsernameInput}
                            onChange={(event) => setMarketUsernameInput(event.target.value)}
                            onBlur={(event) => {
                              const nextUsername = event.currentTarget.value.trim();

                              setMarketUsername(nextUsername);
                              setMarketUsernameInput(nextUsername);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                            }}
                            placeholder="Например, TennoTrader"
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <p className="settings-note">
                          Сравнение не зависит от регистра. Поле применяется после
                          выхода из него. Оставь его пустым, если хочешь считать
                          общий минимум по всем лотам.
                        </p>
                      </div>
                    </article>
                  </div>
                </section>

                <section className="settings-group">
                  <div className="settings-group-header">
                    <h2>Импорт из скриншотов</h2>
                    <p>
                      Загружай один или несколько скриншотов инвентаря.
                      Переключатель ниже определяет, дополнять ли инвентарь или
                      полностью заменять его данными со скриншотов.
                    </p>
                  </div>

                  <div className="settings-list">
                    <article
                      className={`settings-item settings-item-stacked${INVENTORY_IMAGE_IMPORT_DISABLED ? " is-disabled" : ""}`}
                    >
                      <div className="settings-copy">
                        <strong>Импорт инвентаря по изображениям</strong>
                        <p>
                          Имя читается снизу плитки, количество - сверху слева.
                          Нераспознанные строки показываются ниже и не попадают в
                          инвентарь.
                        </p>
                        <p className="settings-note">
                          Можно выбрать сразу несколько файлов. Первый запуск
                          OCR может занять немного времени.
                        </p>
                        <div className="settings-field">
                          <span>Режим импорта</span>
                          <button
                            className={`settings-import-switch ${inventoryImageImportMode === "append" ? "is-append" : "is-replace"}`}
                            type="button"
                            aria-label="Переключить режим импорта из скриншотов"
                            role="switch"
                            aria-checked={inventoryImageImportMode === "replace"}
                            disabled={INVENTORY_IMAGE_IMPORT_DISABLED}
                            onClick={() =>
                              setInventoryImageImportMode((current) =>
                                current === "append" ? "replace" : "append",
                              )
                            }
                          >
                            <span
                              className="settings-import-switch-thumb"
                              aria-hidden="true"
                            />
                            <span className="settings-import-switch-option">
                              Дополнять
                            </span>
                            <span className="settings-import-switch-option">
                              Заменять
                            </span>
                          </button>
                        </div>
                        <p className="settings-note">
                          По умолчанию включено дополнение: новые предметы
                          добавляются, а уже имеющиеся не удаляются. В режиме
                          замены инвентарь полностью синхронизируется со
                          скриншотами.
                        </p>
                        <p className="settings-status is-error">
                          Импорт из скриншотов временно отключён. Блок оставлен
                          в настройках, но сейчас неактивен.
                        </p>
                      </div>

                      <div className="settings-actions">
                        <input
                          ref={inventoryImageImportInputRef}
                          className="file-input-hidden"
                          type="file"
                          accept="image/*"
                          multiple
                          disabled={INVENTORY_IMAGE_IMPORT_DISABLED}
                          onChange={handleInventoryImageImportChange}
                        />
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            setInventoryImageImportFeedback(null);
                            setInventoryImageImportIssues([]);
                            inventoryImageImportInputRef.current?.click();
                          }}
                          disabled={
                            INVENTORY_IMAGE_IMPORT_DISABLED ||
                            catalogState !== "ready" ||
                            isInventoryImageImporting
                          }
                        >
                          {INVENTORY_IMAGE_IMPORT_DISABLED
                            ? "Отключено"
                            : isInventoryImageImporting
                              ? "Распознаю..."
                              : "Импорт изображений"}
                        </button>
                      </div>

                      {!INVENTORY_IMAGE_IMPORT_DISABLED &&
                        inventoryImageImportFeedback && (
                          <p
                            className={`settings-status${inventoryImageImportFeedback.tone === "error" ? " is-error" : " is-success"}`}
                          >
                            {inventoryImageImportFeedback.message}
                          </p>
                        )}

                      {!INVENTORY_IMAGE_IMPORT_DISABLED &&
                        inventoryImageImportIssues.length > 0 && (
                          <div className="settings-import-issues">
                            <div className="settings-import-issues-header">
                              <strong>Спорные предметы</strong>
                              <p className="settings-note">
                                Не удалось сопоставить их с каталогом. Они не
                                попадут в инвентарь, пока не будут распознаны
                                точно.
                              </p>
                            </div>

                            <ul className="settings-import-issues-list">
                              {inventoryImageImportIssues.map((issue) => (
                                <li
                                  key={`${issue.name}-${issue.count}`}
                                  className="settings-import-issue"
                                >
                                  <span title={issue.name}>{issue.name}</span>
                                  <strong>×{issue.count}</strong>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                    </article>
                  </div>
                </section>

                <section className="settings-group">
                  <div className="settings-group-header">
                    <h2>Загрузка данных</h2>
                    <p>
                      Импортируй и экспортируй JSON-файлы, чтобы быстро сохранять
                      и восстанавливать инвентарь и прогресс освоения.
                    </p>
                  </div>

                  <div className="settings-list">
                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Импорт инвентаря</strong>
                        <p>
                          Загружает JSON-массив в формате <code>{`[{ "name": "", "count": 2 }]`}</code>.
                          Для найденных предметов количество обновляется по файлу.
                        </p>
                        {catalogState === "loading" && (
                          <p className="settings-note">
                            Загружаю каталог прайм-предметов для импорта...
                          </p>
                        )}
                        {catalogState === "error" && (
                          <p className="settings-status is-error">
                            {catalogError ?? "Каталог прайм-предметов недоступен."}
                          </p>
                        )}
                        {inventoryImportFeedback && (
                          <p
                            className={`settings-status${inventoryImportFeedback.tone === "error" ? " is-error" : " is-success"}`}
                          >
                            {inventoryImportFeedback.message}
                          </p>
                        )}
                      </div>

                      <div className="settings-actions">
                        <input
                          ref={inventoryImportInputRef}
                          className="file-input-hidden"
                          type="file"
                          accept=".json,application/json"
                          onChange={handleInventoryImportChange}
                        />
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            setInventoryImportFeedback(null);
                            inventoryImportInputRef.current?.click();
                          }}
                          disabled={catalogState !== "ready"}
                        >
                          Импорт JSON
                        </button>
                      </div>
                    </article>

                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Экспорт инвентаря</strong>
                        <p>
                          Сохраняет текущий инвентарь в JSON-массиве формата{" "}
                          <code>{`[{ "name": "", "count": 2 }]`}</code> для
                          последующего импорта.
                        </p>
                      </div>

                      <div className="settings-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={handleInventoryExport}
                          disabled={inventory.length === 0}
                        >
                          Экспорт JSON
                        </button>
                      </div>
                    </article>

                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Импорт освоенных предметов</strong>
                        <p>
                          Загружает JSON-массив в формате <code>{`[{ "name": "", "isMastery": true }]`}</code>.
                          Для найденных предметов статус освоения обновляется по файлу.
                        </p>
                        {masteryCatalogState === "loading" && (
                          <p className="settings-note">
                            Загружаю mastery-каталог для сопоставления имен...
                          </p>
                        )}
                        {masteryCatalogState === "error" && masteryCatalogError && (
                          <p className="settings-note">{masteryCatalogError}</p>
                        )}
                        {masteryImportFeedback && (
                          <p
                            className={`settings-status${masteryImportFeedback.tone === "error" ? " is-error" : " is-success"}`}
                          >
                            {masteryImportFeedback.message}
                          </p>
                        )}
                      </div>

                      <div className="settings-actions">
                        <input
                          ref={masteryImportInputRef}
                          className="file-input-hidden"
                          type="file"
                          accept=".json,application/json"
                          onChange={handleMasteryImportChange}
                        />
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            setMasteryImportFeedback(null);
                            masteryImportInputRef.current?.click();
                          }}
                        >
                          Импорт JSON
                        </button>
                      </div>
                    </article>

                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Экспорт освоенных предметов</strong>
                        <p>
                          Сохраняет текущий mastery-прогресс в JSON-массиве
                          формата <code>{`[{ "name": "", "isMastery": true }]`}</code>,
                          чтобы его можно было импортировать обратно.
                        </p>
                        {masteryCatalogState === "loading" && (
                          <p className="settings-note">
                            Загружаю mastery-каталог для подготовки экспорта...
                          </p>
                        )}
                        {masteryCatalogState === "error" && masteryCatalogError && (
                          <p className="settings-note">{masteryCatalogError}</p>
                        )}
                      </div>

                      <div className="settings-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void handleMasteryExport()}
                          disabled={masteryCatalogState === "loading"}
                        >
                          Экспорт JSON
                        </button>
                      </div>
                    </article>
                  </div>
                </section>

                <section className="settings-group settings-group-danger">
                  <div className="settings-group-header">
                    <h2>Сброс и очистка</h2>
                    <p>Действия, которые меняют или полностью удаляют локальные данные приложения.</p>
                  </div>

                  <div className="settings-list">
                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Очистить освоенные предметы</strong>
                        <p>
                          Сбрасывает отметки mastery для всех предметов в каталоге.
                        </p>
                      </div>

                      <button
                        className="danger-button"
                        type="button"
                        onClick={clearMasteryProgress}
                      >
                        Очистить освоенные
                      </button>
                    </article>

                    <article className="settings-item">
                      <div className="settings-copy">
                        <strong>Очистить весь инвентарь</strong>
                        <p>
                          Удаляет все предметы из инвентаря и очищает связанные с ними локальные
                          данные.
                        </p>
                      </div>

                      <button
                        className="danger-button"
                        type="button"
                        onClick={clearInventoryOnly}
                      >
                        Очистить инвентарь
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
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
