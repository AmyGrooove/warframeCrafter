import Tesseract from "tesseract.js";

const INVENTORY_GRID_COLUMNS = 9;
const OCR_SCALE = 4;
const OCR_DPI = "300";
const NAME_TOP_RATIO = 0.58;
const NAME_HEIGHT_RATIO = 0.4;
const QUANTITY_TOP_RATIO = 0.02;
const QUANTITY_HEIGHT_RATIO = 0.2;
const QUANTITY_ICON_GUARD_RATIO = 0.04;
const NAME_THRESHOLD = 126;
const QUANTITY_THRESHOLD = 142;

export interface ParsedInventoryImageEntry {
  name: string;
  count: number;
}

interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBox;
}

interface OcrLine {
  words: OcrWord[];
}

interface OcrParagraph {
  lines: OcrLine[];
}

interface OcrBlock {
  paragraphs: OcrParagraph[];
}

interface OcrPage {
  blocks: OcrBlock[] | null;
}

interface OcrToken {
  text: string;
  confidence: number;
  centerX: number;
  centerY: number;
  bbox: OcrBox;
}

type OcrWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;

let workerPromise: Promise<OcrWorker> | null = null;

function normalizeOcrText(value: string) {
  return value
    .replace(/[\u200b-\u200d]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLetter(value: string) {
  return /[a-zа-яё]/i.test(value);
}

function toOcrTokens(page: OcrPage) {
  const tokens: OcrToken[] = [];

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = normalizeOcrText(word.text ?? "");

          if (!text) {
            continue;
          }

          tokens.push({
            text,
            confidence: Number.isFinite(word.confidence) ? word.confidence : 0,
            centerX: (word.bbox.x0 + word.bbox.x1) / 2,
            centerY: (word.bbox.y0 + word.bbox.y1) / 2,
            bbox: word.bbox,
          });
        }
      }
    }
  }

  return tokens;
}

async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker("rus");

      try {
        await worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
          preserve_interword_spaces: "1",
          user_defined_dpi: OCR_DPI,
        });
      } catch (error) {
        await worker.terminate().catch(() => undefined);
        throw error;
      }

      return worker;
    })().catch((error: unknown) => {
      workerPromise = null;
      throw error instanceof Error
        ? new Error(`Не удалось загрузить OCR-движок: ${error.message}`)
        : new Error("Не удалось загрузить OCR-движок.");
    });
  }

  return workerPromise;
}

async function loadImageElement(file: File) {
  const objectUrl = URL.createObjectURL(file);

  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Не удалось прочитать изображение ${file.name}.`));
      };

      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

type OcrRegionKind = "name" | "quantity";

function buildPreparedRegionCanvas(
  source: HTMLImageElement,
  left: number,
  top: number,
  width: number,
  height: number,
  kind: OcrRegionKind,
  scale = OCR_SCALE,
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Не удалось подготовить область изображения для OCR.");
  }

  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    left,
    top,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const threshold = kind === "quantity" ? QUANTITY_THRESHOLD : NAME_THRESHOLD;

  for (let index = 0; index < pixels.length; index += 4) {
    const luminance =
      pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    const value = luminance >= threshold ? 0 : 255;

    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);

  return canvas;
}

async function recognizeRegion(
  worker: OcrWorker,
  source: HTMLCanvasElement,
) {
  const result = await worker.recognize(
    source,
    {},
    {
      text: true,
      blocks: true,
    },
  );

  return result.data as OcrPage;
}

function buildRowBounds(imageHeight: number, rowIndex: number, rowPitch: number) {
  const top = Math.max(0, rowIndex * rowPitch);
  const bottom = Math.min(imageHeight, top + rowPitch);

  return {
    top,
    height: Math.max(1, bottom - top),
  };
}

function groupTokensByColumn<T extends OcrToken>(tokens: T[], stripWidth: number) {
  const columnWidth = stripWidth / INVENTORY_GRID_COLUMNS;
  const columns = Array.from({ length: INVENTORY_GRID_COLUMNS }, () => [] as T[]);

  for (const token of tokens) {
    const columnIndex = Math.min(
      INVENTORY_GRID_COLUMNS - 1,
      Math.max(0, Math.floor(token.centerX / columnWidth)),
    );

    columns[columnIndex].push(token);
  }

  return columns;
}

function extractNameCandidates(page: OcrPage, stripWidth: number) {
  const tokens = toOcrTokens(page).filter((token) => hasLetter(token.text) && !/\d/.test(token.text));
  const columns = groupTokensByColumn(tokens, stripWidth);

  return columns.map((columnTokens) => {
    if (columnTokens.length === 0) {
      return "";
    }

    const orderedTokens = [...columnTokens].sort((left, right) => {
      if (left.bbox.y0 !== right.bbox.y0) {
        return left.bbox.y0 - right.bbox.y0;
      }

      return left.bbox.x0 - right.bbox.x0;
    });

    return normalizeOcrText(orderedTokens.map((token) => token.text).join(" "));
  });
}

function extractQuantityCandidates(page: OcrPage, stripWidth: number) {
  const tokens = toOcrTokens(page)
    .map((token) => ({
      ...token,
      digits: token.text.replace(/\D/g, ""),
    }))
    .filter((token) => token.digits.length > 0);
  const columns = groupTokensByColumn(tokens, stripWidth);
  const columnWidth = stripWidth / INVENTORY_GRID_COLUMNS;

  return columns.map((columnTokens, columnIndex) => {
    if (columnTokens.length === 0) {
      return null;
    }

    const guardedTokens = columnTokens.filter(
      (token) =>
        token.centerX - columnIndex * columnWidth >= columnWidth * QUANTITY_ICON_GUARD_RATIO,
    );
    const orderedTokens = [...(guardedTokens.length > 0 ? guardedTokens : columnTokens)].sort(
      (left, right) => {
        if (left.centerX !== right.centerX) {
          return left.centerX - right.centerX;
        }

        if (left.centerY !== right.centerY) {
          return left.centerY - right.centerY;
        }

        return right.confidence - left.confidence;
      },
    );

    const digits = orderedTokens.map((token) => token.digits).join("");
    const quantity = Number.parseInt(digits, 10);

    return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
  });
}

function clampQuantity(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export async function parseInventoryImageFile(file: File) {
  const image = await loadImageElement(file);
  const worker = await getOcrWorker();
  const pitch = image.naturalWidth / INVENTORY_GRID_COLUMNS;
  const rowCount = Math.max(1, Math.round(image.naturalHeight / pitch));
  const parsedEntries: ParsedInventoryImageEntry[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const { top: rowTop, height: rowHeight } = buildRowBounds(
      image.naturalHeight,
      rowIndex,
      pitch,
    );

    const nameTop = rowTop + rowHeight * NAME_TOP_RATIO;
    const nameHeight = Math.min(
      image.naturalHeight - nameTop,
      rowHeight * NAME_HEIGHT_RATIO,
    );
    const quantityTop = rowTop + rowHeight * QUANTITY_TOP_RATIO;
    const quantityHeight = Math.min(
      image.naturalHeight - quantityTop,
      rowHeight * QUANTITY_HEIGHT_RATIO,
    );

    if (nameHeight <= 0 || quantityHeight <= 0) {
      continue;
    }

    const nameCanvas = buildPreparedRegionCanvas(
      image,
      0,
      nameTop,
      image.naturalWidth,
      nameHeight,
      "name",
    );
    const quantityCanvas = buildPreparedRegionCanvas(
      image,
      0,
      quantityTop,
      image.naturalWidth,
      quantityHeight,
      "quantity",
    );

    const [namePage, quantityPage] = await Promise.all([
      recognizeRegion(worker, nameCanvas),
      recognizeRegion(worker, quantityCanvas),
    ]);

    const nameCandidates = extractNameCandidates(namePage, nameCanvas.width);
    const quantityCandidates = extractQuantityCandidates(
      quantityPage,
      quantityCanvas.width,
    );

    for (let columnIndex = 0; columnIndex < INVENTORY_GRID_COLUMNS; columnIndex += 1) {
      const name = nameCandidates[columnIndex];

      if (!name) {
        continue;
      }

      parsedEntries.push({
        name,
        count: clampQuantity(quantityCandidates[columnIndex]),
      });
    }
  }

  return parsedEntries;
}
