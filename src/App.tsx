import { useEffect, useMemo, useState } from "react";
import { fetchPrimeCatalog, fetchPrimePrice } from "./lib/warframeMarket";
import { loadFromStorage, saveToStorage } from "./lib/storage";
import type {
  AppLocale,
  InventoryItem,
  InventoryRow,
  LocalizedNames,
  MarketItem,
  PriceSnapshot,
} from "./types";

const INVENTORY_KEY = "wf-prime-tracker:inventory:v1";
const LANGUAGE_KEY = "wf-prime-tracker:language:v1";
const REQUEST_DELAY_MS = 350;

type AppSection = "inventory" | "pricing" | "settings";

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
    id: "settings",
    label: "Настройки",
    description: "Параметры интерфейса и отображения.",
  },
];

function InventorySectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Zm3 1.5v3h3V8H7Zm4 0v3h3V8h-3Zm4 0v3h2V8h-2Zm-8 4v3h3v-3H7Zm4 0v3h3v-3h-3Zm4 0v3h2v-3h-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PricingSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 19h14v1.5H3.5V5H5v14Zm3.2-2.4-1.4-1 3.3-4.6 2.6 2.4 4.2-5 1.1.9-5.2 6.3-2.7-2.5-1.9 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SettingsSectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M10.5 3h3l.5 2.1a7.9 7.9 0 0 1 1.9.8l1.9-1.1 2.1 2.1-1.1 1.9c.34.6.6 1.24.8 1.9L21 12v3l-2.1.5a7.9 7.9 0 0 1-.8 1.9l1.1 1.9-2.1 2.1-1.9-1.1a7.9 7.9 0 0 1-1.9.8L13.5 21h-3l-.5-2.1a7.9 7.9 0 0 1-1.9-.8l-1.9 1.1-2.1-2.1 1.1-1.9a7.9 7.9 0 0 1-.8-1.9L3 15v-3l2.1-.5c.19-.66.46-1.3.8-1.9L4.8 7.7 6.9 5.6l1.9 1.1a7.9 7.9 0 0 1 1.9-.8L10.5 3Zm1.5 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5a7 7 0 0 1 6.2 3.75V6.5h1.5V12h-5.5v-1.5h3.1A5.5 5.5 0 1 0 17 16.7l1.25.83A7 7 0 1 1 12 5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14 4h6v6h-1.5V6.56l-7.97 7.97-1.06-1.06 7.97-7.97H14V4Zm-8 3.5h5V9H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-5h1.5v5A2.5 2.5 0 0 1 14 20.5H6A2.5 2.5 0 0 1 3.5 18v-8A2.5 2.5 0 0 1 6 7.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SectionIcon({ section }: { section: AppSection }) {
  if (section === "inventory") {
    return <InventorySectionIcon />;
  }

  if (section === "pricing") {
    return <PricingSectionIcon />;
  }

  return <SettingsSectionIcon />;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getMarketItemUrl(slug: string) {
  return `https://warframe.market/items/${slug}`;
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

  useEffect(() => {
    saveToStorage(INVENTORY_KEY, inventory);
  }, [inventory]);

  useEffect(() => {
    saveToStorage(LANGUAGE_KEY, language);
  }, [language]);

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
        };
      }),
    );
  }, [catalog]);

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
      .slice(0, 8);
  }, [catalog, inventory, language, search]);

  const rows = useMemo(
    () => mergeRows(inventory, catalog, priceMap, loadingSlugs, errors),
    [catalog, inventory, priceMap, loadingSlugs, errors],
  );
  const activeSectionMeta =
    APP_SECTIONS.find((section) => section.id === activeSection) ?? APP_SECTIONS[0];

  const totals = useMemo(() => {
    return rows.reduce(
      (summary, row) => {
        summary.uniqueItems += 1;
        summary.totalQuantity += row.quantity;

        if (row.price && row.price.minSellPrice !== null) {
          summary.totalSellValue += row.price.minSellPrice * row.quantity;
        }

        if (row.price && row.price.maxBuyPrice !== null) {
          summary.totalBuyValue += row.price.maxBuyPrice * row.quantity;
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
  }, [rows]);

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
                  <div className="item-grid">
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
                        {rows.length === 0
                          ? "Пока пусто"
                          : `${rows.length} позиций в коллекции`}
                      </p>
                    </div>
                  </div>
                  <span className="table-note">
                    Управляй количеством здесь, цены смотри во вкладке стоимости.
                  </span>
                </div>

                {rows.length === 0 ? (
                  <div className="empty-state">
                    <h3>Инвентарь пуст</h3>
                    <p>Добавь предметы через поиск выше.</p>
                  </div>
                ) : (
                  <div className="item-grid owned-grid">
                    {rows.map((row) => (
                      <article key={row.slug} className="item-card owned-card">
                        <ItemPreview item={row} language={language} />

                        <div className="item-card-body">
                          <strong>
                            {getLocalizedName(row.names, row.name, language)}
                          </strong>
                          <span>{row.slug}</span>
                        </div>

                        <div className="owned-card-footer">
                          <label className="card-quantity">
                            <span>Кол-во</span>
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

                          <div className="owned-card-meta">
                            <span className="owned-card-price">
                              {row.price?.minSellPrice !== null
                                ? formatPlatinum(row.price?.minSellPrice ?? null)
                                : "—"}
                            </span>
                            <button
                              className="danger-button"
                              type="button"
                              onClick={() => removeItem(row.slug)}
                            >
                              Удалить
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
                  <strong>{totals.uniqueItems}</strong>
                </article>
                <article className="summary-card">
                  <span>Штук</span>
                  <strong>{totals.totalQuantity}</strong>
                </article>
                <article className="summary-card">
                  <span>Мин. продажа</span>
                  <strong>{formatPlatinum(totals.totalSellValue)}</strong>
                </article>
                <article className="summary-card">
                  <span>Макс. покупка</span>
                  <strong>{formatPlatinum(totals.totalBuyValue)}</strong>
                </article>
              </section>

              <section className="panel pricing-panel">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2>Стоимость прайм предметов</h2>
                    <p>{rows.length === 0 ? "Пусто" : `${rows.length} позиций`}</p>
                  </div>
                  <span className="table-note">
                    Продажа = минимальная цена у продавцов, покупка = лучшая ставка покупателя
                  </span>
                </div>

                {rows.length === 0 ? (
                  <div className="empty-state">
                    <h3>Нет предметов для оценки</h3>
                    <p>Сначала добавь их во вкладке инвентаря.</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="inventory-table">
                      <thead>
                        <tr>
                          <th>Предмет</th>
                          <th>Кол-во</th>
                          <th>Мин. продажа</th>
                          <th>Макс. покупка</th>
                          <th>Сумма</th>
                          <th>Обновлено</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const total =
                            row.price?.minSellPrice !== null && row.price
                              ? row.price.minSellPrice * row.quantity
                              : null;

                          return (
                            <tr key={row.slug}>
                              <td>
                                <div className="item-name-cell">
                                  <strong>
                                    {getLocalizedName(row.names, row.name, language)}
                                  </strong>
                                  <span>{row.slug}</span>
                                  {row.error && (
                                    <span className="inline-error">{row.error}</span>
                                  )}
                                </div>
                              </td>
                              <td>{row.quantity}</td>
                              <td>{formatPlatinum(row.price?.minSellPrice ?? null)}</td>
                              <td>{formatPlatinum(row.price?.maxBuyPrice ?? null)}</td>
                              <td>{formatPlatinum(total)}</td>
                              <td>{formatTimestamp(row.price?.updatedAt ?? null)}</td>
                              <td>
                                <div className="row-actions">
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
          ) : (
            <section className="panel settings-panel">
              <div className="section-heading">
                <div>
                  <h2>Настройки</h2>
                  <p>Базовые параметры приложения.</p>
                </div>
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
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
