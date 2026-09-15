import type { RawLeadRow } from "@/engine/businessImport";

/** Maps a spreadsheet header cell's exact text to the RawLeadRow field it
 * feeds. Everything else in the source file (Data Captain, Suggested
 * Category, Workers Declared, Workers Photographed, Hard Tasks, Outcome,
 * Status, Risk Score, Submitted At, DC Code) has no entry here and is never
 * read — see src/engine/businessImport.ts's file header for why. */
const HEADER_MAP: Record<string, keyof RawLeadRow> = {
  "business code": "businessCode",
  "business name": "businessName",
  "contact phone": "contactPhone",
  city: "city",
  category: "category",
  address: "address",
  "maps link": "mapsLink",
  latitude: "latitude",
  longitude: "longitude",
  "contact name": "contactName",
};

const REQUIRED_HEADERS: (keyof RawLeadRow)[] = ["businessCode", "businessName"];

export interface ParsedLeadSpreadsheet {
  rows: RawLeadRow[];
  /** Headers this parser recognized, in the order they were found. */
  recognizedHeaders: string[];
  /** True only when every column this importer actually needs was found —
   * a Manager should never see a preview built from a mis-shaped file. */
  hasRequiredHeaders: boolean;
}

function cellText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") {
    // exceljs hyperlink cells: { text, hyperlink }, and rich-text cells:
    // { richText: [{ text }, ...] }. Prefer the visible text; fall back to
    // the link target itself (a Maps Link cell is a URL either way).
    const v = value as { text?: unknown; hyperlink?: unknown; richText?: { text?: string }[]; result?: unknown };
    if (typeof v.text === "string") return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text ?? "").join("");
    if (typeof v.hyperlink === "string") return v.hyperlink;
    if (v.result != null) return String(v.result);
    return undefined;
  }
  return String(value);
}

/** Parses the first worksheet of an uploaded lead spreadsheet into raw,
 * unvalidated rows. Pure column-to-field mapping only — every validation,
 * duplicate check, and write decision happens in
 * src/engine/businessImport.ts's planBusinessImport(), not here. Accepts an
 * ArrayBuffer so the same function works from a browser File
 * (`await file.arrayBuffer()`) and from a Node Buffer in tests
 * (`buffer.buffer`). exceljs is imported dynamically so this feature's
 * (sizeable) parsing dependency never lands in the app's main bundle — it
 * only loads when a Manager actually opens the import flow. */
export async function parseLeadSpreadsheet(input: ArrayBuffer): Promise<ParsedLeadSpreadsheet> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], recognizedHeaders: [], hasRequiredHeaders: false };

  const headerRow = sheet.getRow(1);
  const columnFields = new Map<number, keyof RawLeadRow>();
  const recognizedHeaders: string[] = [];
  headerRow.eachCell((cell, colNumber) => {
    const text = cellText(cell.value)?.trim().toLowerCase();
    if (!text) return;
    const field = HEADER_MAP[text];
    if (field) {
      columnFields.set(colNumber, field);
      recognizedHeaders.push(text);
    }
  });

  const rows: RawLeadRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    // Skip fully-blank rows (trailing empty rows are common in exported
    // spreadsheets and aren't real data).
    let anyValue = false;
    const raw: RawLeadRow = { rowNumber };
    for (const [colNumber, field] of columnFields) {
      const text = cellText(row.getCell(colNumber).value);
      if (text != null && text.trim() !== "") anyValue = true;
      (raw as unknown as Record<string, unknown>)[field] = text;
    }
    if (anyValue) rows.push(raw);
  });

  const hasRequiredHeaders = REQUIRED_HEADERS.every((f) => Array.from(columnFields.values()).includes(f));
  return { rows, recognizedHeaders, hasRequiredHeaders };
}
