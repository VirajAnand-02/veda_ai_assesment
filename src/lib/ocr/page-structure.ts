import { overlapArea, unionBox } from "@/lib/extraction/geometry";
import type { Box, TextLine } from "@/lib/extraction/types";
import { joinStackedLabels, sortReadingOrder } from "./merge-lines";

// Turns a text-only OCR read into one with tables and diagrams.
//
// Tables are found from the OCR's own cell boxes: a grid is at least three
// rows whose cells line up in at least two columns. A grid only counts as a
// table when a detector also sees one there — NVIDIA page-elements (precise
// boxes, trained on printed pages, low confidence on handwriting) or the
// vision LLM (sees tables, but on real answer sheets its boxes sat 3–10% of
// the page too high). So an LLM "table" over prose (no grid) is dropped, and a
// list that happens to line up (a grid no detector calls a table) stays text.
// A table's rows come from its cells, and question labels ("2. (b) …") never
// become part of one.
//
// Diagrams come from the vision LLM (and page-elements charts). Their position
// comes from the labels the LLM's description names, which the OCR boxed
// precisely, rather than from the LLM's box.

export type PageRegion = {
  kind: "table" | "diagram";
  box: Box;
  description: string;
  source: "elements" | "llm";
  /** page-elements' confidence; 1 for the LLM. */
  confidence: number;
};

export type StructuredPage = { lines: TextLine[]; tables: number; diagrams: number };

/** Page-elements tables at least this sure are considered at all… */
const ELEMENT_TABLE_MIN = 0.1;
/** …and at least this sure count without a grid or the LLM agreeing. */
const ELEMENT_TABLE_SURE = 0.5;
const ELEMENT_CHART_MIN = 0.5;
const TABLE_PAD = 0.01;
const TABLE_PAD_Y = 0.004;
const DIAGRAM_PAD = 0.02;
/** Labels named by an LLM description are searched this far from its box (page fractions). */
const LABEL_SEARCH = 0.2;
/** The drawing sits between its labels; pad their union to take in its edges. */
const LABEL_UNION_PAD = 0.04;
const LABEL_MAX_WORDS = 4;

/** "Q2", "Ans 3", "Question 11" start an answer; they're never a drawing's label. */
export const QUESTION_LABEL = /^(q(ues(tion)?)?|ans(wer)?)\.?\s*\d/i;

/** A sheet's page header ("Page 7"), never a drawing's label. */
const PAGE_NUMBER = /^\s*page\s*\d+\s*$/i;

/** Starts an answer or a part of one: "2. (b) Given…", "(ii) Column wise…", "Q3 (a)", "8. Consider…". Never a table cell. */
export const ANSWER_LABEL =
  /^\s*(?:(?:q(?:ues(?:tion)?)?|ans(?:wer)?)\.?\s*)?(?:\d{1,2}\s*[.)]\s*)?\(\s*(?:[a-h]|[ivx]{1,4})\s*\)\s*\S|^\s*(?:(?:q(?:ues(?:tion)?)?|ans(?:wer)?)\.?\s*)?\d{1,2}\s*\.\s+\S/i;

/** Page-elements detections and LLM drawings → candidate regions. */
export function combineRegions(
  elements: { kind: string; box: Box; confidence: number }[],
  drawings: { kind: string; box: Box; description: string }[],
): PageRegion[] {
  const regions: PageRegion[] = elements.flatMap((element): PageRegion[] => {
    if (element.kind === "table" && element.confidence >= ELEMENT_TABLE_MIN) {
      return [{ kind: "table" as const, box: element.box, description: "", source: "elements" as const, confidence: element.confidence }];
    }
    if (/^(chart|infographic)$/.test(element.kind) && element.confidence >= ELEMENT_CHART_MIN) {
      return [{ kind: "diagram" as const, box: element.box, description: "", source: "elements" as const, confidence: element.confidence }];
    }
    return [];
  });

  for (const drawing of drawings) {
    if (/table/i.test(drawing.kind)) {
      regions.push({ kind: "table", box: drawing.box, description: drawing.description, source: "llm", confidence: 1 });
      continue;
    }
    // A chart found by both: keep the precise box, add the description.
    const same = regions.find(
      (region) =>
        region.kind === "diagram" &&
        region.source === "elements" &&
        overlapArea(region.box, drawing.box) >= 0.5 * Math.min(area(region.box), area(drawing.box)),
    );
    if (same) same.description ||= drawing.description;
    else regions.push({ kind: "diagram", box: drawing.box, description: drawing.description, source: "llm", confidence: 1 });
  }
  return regions;
}

/**
 * `lines` are the OCR's joined lines; `segments` its boxes before joining (in a
 * table, usually one per cell). Without segments, lines are used for both.
 */
export function applyPageStructure(lines: TextLine[], regions: PageRegion[], segments: TextLine[] = lines): StructuredPage {
  const labelLines = lines.filter((line) => ANSWER_LABEL.test(line.text));
  const cells = segments.filter((segment) => !labelLines.some((label) => containsPoint(pad(label.box, 0.002), center(segment.box))));

  const tables = resolveTables(cells, regions.filter((region) => region.kind === "table"));
  let remaining = lines.filter(
    (line) => ANSWER_LABEL.test(line.text) || !tables.some((table) => containsPoint(table.core, center(line.box))),
  );
  const tableLines = tables.map((table) => ({
    text: `[table: ${table.rows.map((row) => row.map((cell) => cell.text).join(" | ")).join(" / ")}]`,
    box: table.box,
  }));

  const diagrams: TextLine[] = [];
  for (const region of regions.filter((candidate) => candidate.kind === "diagram")) {
    // Something the table step already read as a table (its cells are exact).
    if (tables.some((table) => overlapArea(table.box, region.box) >= 0.5 * Math.min(area(table.box), area(region.box)))) continue;

    const short = remaining.filter(
      (line) =>
        !QUESTION_LABEL.test(line.text) &&
        !PAGE_NUMBER.test(line.text) &&
        line.text.trim().split(/\s+/).length <= LABEL_MAX_WORDS,
    );
    const inside = short.filter((line) => mostlyInside(line.box, pad(region.box, DIAGRAM_PAD)));
    const named = region.description
      ? short.filter((line) => distance(line.box, region.box) <= LABEL_SEARCH && namedIn(line.text, region.description))
      : [];

    let labels: TextLine[];
    let box: Box;
    if (region.source === "llm" && named.length >= 2) {
      // Trust the labels over the LLM's box.
      labels = named;
      box = pad(unionBox(named.map((label) => label.box)), LABEL_UNION_PAD);
    } else {
      labels = [...new Set([...inside, ...named])];
      box = unionBox([region.box, ...labels.map((label) => label.box)]);
    }
    remaining = remaining.filter((line) => !labels.includes(line));

    const labelText = joinStackedLabels(sortReadingOrder(labels))
      .map((label) => stripArrows(label.text))
      .filter(Boolean)
      .join(", ");
    const parts = [region.description.replace(/\.$/, ""), labelText && `Labels: ${labelText}`].filter(Boolean);
    diagrams.push({ text: `[diagram: ${parts.join(". ") || "drawing"}]`, box });
  }

  return {
    lines: sortReadingOrder([...remaining, ...tableLines, ...diagrams]),
    tables: tableLines.length,
    diagrams: diagrams.length,
  };
}

// ---------------------------------------------------------------------------
// Tables

type Grid = { cells: TextLine[]; rows: TextLine[][]; box: Box };
type Table = { rows: TextLine[][]; box: Box; core: Box };

function resolveTables(cells: TextLine[], candidates: PageRegion[]): Table[] {
  const elements = candidates.filter((region) => region.source === "elements");
  const llm = candidates.filter((region) => region.source === "llm");
  const grids = findGrids(cells)
    .flatMap((grid) => splitStacked(grid, elements))
    .flatMap((grid) => splitGrid(grid, candidates));

  // Each LLM table points at the one grid it overlaps most (its boxes drift, so
  // a loose overlap is enough), never at several.
  const llmGrid = new Map<PageRegion, Grid>();
  for (const region of llm) {
    const best = maxBy(grids, (grid) => overlapArea(grid.box, region.box));
    if (best && overlapArea(best.box, region.box) >= 0.2 * Math.min(area(best.box), area(region.box))) llmGrid.set(region, best);
  }
  const elementGrids = (element: PageRegion) =>
    grids.filter((grid) => overlapArea(grid.box, element.box) >= 0.4 * Math.min(area(grid.box), area(element.box)));

  const tables: Table[] = [];
  const usedElements = new Set<PageRegion>();
  for (const grid of grids) {
    const matchedElements = elements.filter((element) => elementGrids(element).includes(grid));
    const seenByLlm = llm.some((region) => llmGrid.get(region) === grid);
    if (!matchedElements.length && !seenByLlm) continue; // lines up, but nothing calls it a table (e.g. a list)
    matchedElements.forEach((element) => usedElements.add(element));

    // The grid is exact vertically; a page-elements box that is about this one
    // table also gives the drawn borders left and right.
    // Little vertical padding: a heading often sits right above a table.
    const padded = pad(grid.box, TABLE_PAD);
    const top = Math.max(0, grid.box.y - TABLE_PAD_Y);
    let box = { ...padded, y: top, h: Math.min(1, grid.box.y + grid.box.h + TABLE_PAD_Y) - top };
    const own = matchedElements.find((element) => elementGrids(element).length === 1);
    if (own) {
      const left = Math.min(box.x, own.box.x);
      const right = Math.max(box.x + box.w, own.box.x + own.box.w);
      box = { ...box, x: left, w: right - left };
    }
    tables.push({ rows: grid.rows, box, core: pad(grid.box, 0.004) });
  }

  // Tables page-elements is sure of (or the LLM agrees with) but whose cells
  // don't form a clean grid, e.g. bullet points in cells.
  for (const element of elements) {
    if (usedElements.has(element)) continue;
    const agreed = llm.some((region) => overlapArea(region.box, element.box) >= 0.3 * Math.min(area(region.box), area(element.box)));
    if (element.confidence < ELEMENT_TABLE_SURE && !agreed) continue;
    if (tables.some((table) => overlapArea(table.box, element.box) >= 0.3 * Math.min(area(table.box), area(element.box)))) continue;
    const inside = cells.filter((cell) => containsPoint(element.box, center(cell.box)));
    if (inside.length < 2) continue;
    tables.push({ rows: groupRows(inside), box: element.box, core: element.box });
  }
  return tables;
}

/** A cell starting this close to a column's left edge belongs to that column (page widths). */
const COLUMN_ALIGN = 0.02;
const MIN_GRID_ROWS = 3;
/** Rows of one table are at most this many row heights apart. */
const MAX_ROW_GAP = 1.5;
/** …or this many when the row repeats the one above's columns (a table with tall rows). */
const MAX_ALIGNED_ROW_GAP = 3;
/** One-cell rows (a wrapped cell) allowed between two grid rows. */
const MAX_SINGLE_ROWS = 2;

/** Runs of rows whose cells line up in columns. */
export function findGrids(cells: TextLine[]): Grid[] {
  const rows = groupRows(cells);
  if (rows.length < MIN_GRID_ROWS) return [];
  const heights = rows.map((row) => rowBottom(row) - rowTop(row)).sort((a, b) => a - b);
  const rowHeight = heights[Math.floor(heights.length / 2)];

  // Runs of close rows with 2+ cells, allowing a few one-cell rows in between.
  const runs: TextLine[][][] = [];
  let run: TextLine[][] = [];
  let singles: TextLine[][] = [];
  const close = () => {
    if (run.filter((row) => row.length >= 2).length >= MIN_GRID_ROWS) runs.push(run);
    run = [];
    singles = [];
  };
  for (const row of rows) {
    const previous = singles.at(-1) ?? run.at(-1);
    if (previous) {
      const gap = rowTop(row) - rowBottom(previous);
      const sameColumns = row.filter((cell) => previous.some((above) => Math.abs(above.box.x - cell.box.x) <= COLUMN_ALIGN)).length >= 2;
      if (gap > (sameColumns ? MAX_ALIGNED_ROW_GAP : MAX_ROW_GAP) * rowHeight) close();
    }
    if (row.length >= 2) {
      run.push(...singles, row);
      singles = [];
    } else if (run.length) {
      singles.push(row);
      if (singles.length > MAX_SINGLE_ROWS) close();
    }
  }
  close();

  return runs.flatMap(shapeGrid);
}

/** Wide tables (this many cells a row or more) have no one-line wrapped cells. */
const WIDE_TABLE = 4;

/**
 * Drops the rows that don't belong to the grid, splitting it there. In a wide
 * table a row with at most half the usual cells is a heading, a total, or text
 * between two stacked tables ("Allocation matrix: | Max matrix:", "Total page
 * faults = 9"). In a two- or three-column table a one-cell row is a wrapped
 * cell when it starts in a column, and text otherwise.
 */
function shapeGrid(run: TextLine[][]): Grid[] {
  const multi = run.filter((row) => row.length >= 2);
  const columns = alignedColumns(multi.flat(), Math.max(2, 0.4 * multi.length));
  if (columns.length < 2) return [];
  const counts = multi.map((row) => row.length).sort((a, b) => a - b);
  const typical = counts[Math.floor(counts.length / 2)];
  const fits = (row: TextLine[]) =>
    typical >= WIDE_TABLE
      ? row.length > typical / 2
      : row.length >= 2 || columns.some((column) => Math.abs(row[0].box.x - column) <= 2 * COLUMN_ALIGN);

  const pieces: TextLine[][][] = [[]];
  for (const row of run) {
    if (fits(row)) pieces.at(-1)!.push(row);
    else if (pieces.at(-1)!.length) pieces.push([]);
  }
  return pieces.flatMap((piece) => {
    // A totals or working line just above or below a table ("Total time (SSTF) = 166 ns").
    let rows = piece;
    while (rows.length && isWorkingLine(rows[0])) rows = rows.slice(1);
    while (rows.length && isWorkingLine(rows.at(-1)!)) rows = rows.slice(0, -1);
    const rowsWithCells = rows.filter((row) => row.length >= 2);
    if (rowsWithCells.length < MIN_GRID_ROWS || alignedColumns(rowsWithCells.flat(), Math.max(2, 0.4 * rowsWithCells.length)).length < 2) {
      return [];
    }
    const gridCells = rows.flat();
    return [{ cells: gridCells, rows, box: unionBox(gridCells.map((cell) => cell.box)) }];
  });
}

/** Column left edges shared by at least `minCount` cells. */
function alignedColumns(cells: TextLine[], minCount: number): number[] {
  const clusters: { x: number; count: number }[] = [];
  for (const x of cells.map((cell) => cell.box.x).sort((a, b) => a - b)) {
    const last = clusters.at(-1);
    if (last && x - last.x <= COLUMN_ALIGN) last.count++;
    else clusters.push({ x, count: 1 });
  }
  return clusters.filter((cluster) => cluster.count >= minCount).map((cluster) => cluster.x);
}

/**
 * Two tables side by side read as one grid. Split it where detectors see
 * separate tables, or at an empty vertical gap much wider than the gaps
 * between its columns.
 */
export function splitGrid(grid: Grid, detectors: PageRegion[]): Grid[] {
  // Candidate cuts, most trusted first: between detector boxes, then at the widest empty bands.
  const candidates: number[] = [];

  // Detector boxes over part of the grid, grouped by horizontal extent.
  const narrow = detectors
    .filter((detector) => detector.box.w <= 0.75 * grid.box.w && horizontalOverlap(detector.box, grid.box) >= 0.5 * detector.box.w && verticalOverlap(detector.box, grid.box) > 0)
    .map((detector) => [detector.box.x, detector.box.x + detector.box.w] as const)
    .sort((a, b) => a[0] - b[0]);
  const groups: [number, number][] = [];
  for (const [start, end] of narrow) {
    const last = groups.at(-1);
    if (last && start < last[1] - 0.2 * Math.min(end - start, last[1] - last[0])) last[1] = Math.max(last[1], end);
    else groups.push([start, end]);
  }
  for (let index = 1; index < groups.length; index++) candidates.push((groups[index - 1][1] + groups[index][0]) / 2);

  // Empty vertical bands across all rows, much wider than the usual gap between columns.
  const gaps = emptyBands(grid);
  if (gaps.length >= 2) {
    const widths = gaps.map((gap) => gap.width).sort((a, b) => a - b);
    const typical = widths[Math.floor(widths.length / 2)];
    gaps
      .filter((gap) => gap.width >= Math.max(0.035, 2 * typical))
      .sort((a, b) => b.width - a.width)
      .forEach((gap) => candidates.push(gap.at));
  }

  // Keep each cut only if every part it leaves is still a table.
  let cuts: number[] = [];
  let result = [grid];
  for (const cut of candidates) {
    if (cuts.some((existing) => Math.abs(existing - cut) < 0.02)) continue;
    const trial = [...cuts, cut].sort((a, b) => a - b);
    const parts = [-Infinity, ...trial].map((left, index) =>
      grid.cells.filter((cell) => {
        const middle = cell.box.x + cell.box.w / 2;
        return middle >= left && middle < (trial[index] ?? Infinity);
      }),
    );
    const grids = parts.map((part) => findGrids(part));
    if (grids.every((found) => found.length === 1)) {
      cuts = trial;
      result = grids.flat();
    }
  }
  return result;
}

const isWorkingLine = (row: TextLine[]) => {
  const text = row.map((cell) => cell.text).join(" ");
  return text.includes("=") || /^\s*total\b/i.test(text);
};

/** A page-elements box must cover at least this much of a grid's width to cut it across. */
const STACK_CUT_WIDTH = 0.5;

/**
 * Tables stacked close together (or a Gantt chart just above a table) can read
 * as one grid. Page-elements boxes each table on its own, so cut the grid at
 * their top and bottom edges. A cut stands when both sides are tables; for a
 * box page-elements is sure of, it's enough that the side inside it is, and the
 * other side goes back to being text.
 */
function splitStacked(grid: Grid, elements: PageRegion[]): Grid[] {
  const cuts = elements
    .filter((element) => horizontalOverlap(element.box, grid.box) >= STACK_CUT_WIDTH * grid.box.w)
    .flatMap((element) => [element.box.y, element.box.y + element.box.h].map((y) => ({ y, element })))
    .filter(({ y }) => y > grid.box.y + 0.01 && y < grid.box.y + grid.box.h - 0.01)
    .sort((a, b) => b.element.confidence - a.element.confidence);

  let parts = [grid];
  for (const { y, element } of cuts) {
    const part = parts.find((candidate) => y > candidate.box.y && y < candidate.box.y + candidate.box.h);
    if (!part) continue;
    const above = findGrids(part.rows.filter((row) => rowCenter(row) < y).flat());
    const below = findGrids(part.rows.filter((row) => rowCenter(row) >= y).flat());
    const inside = element.box.y > y - 0.001 ? below : above; // the side the element box is on
    let kept: Grid[] | null = null;
    if (above.length === 1 && below.length === 1) kept = [...above, ...below];
    else if (element.confidence >= ELEMENT_TABLE_SURE && inside.length === 1) kept = inside;
    if (kept) parts = parts.flatMap((candidate) => (candidate === part ? kept : [candidate]));
  }
  return parts;
}

const rowCenter = (row: TextLine[]) => (rowTop(row) + rowBottom(row)) / 2;

/** Horizontal gaps no cell covers, between the grid's leftmost and rightmost cell. */
function emptyBands(grid: Grid): { at: number; width: number }[] {
  const spans = grid.cells.map((cell) => [cell.box.x, cell.box.x + cell.box.w] as const).sort((a, b) => a[0] - b[0]);
  const bands: { at: number; width: number }[] = [];
  let reach = spans[0]?.[1] ?? 0;
  for (const [start, end] of spans.slice(1)) {
    if (start > reach) bands.push({ at: (reach + start) / 2, width: start - reach });
    reach = Math.max(reach, end);
  }
  return bands;
}

/** Cells grouped into rows (top to bottom), each left to right. */
function groupRows(cells: TextLine[]): TextLine[][] {
  const rows: { cells: TextLine[]; top: number; bottom: number }[] = [];
  for (const cell of [...cells].sort((a, b) => a.box.y - b.box.y)) {
    const row = rows.find((candidate) => {
      const overlap = Math.min(cell.box.y + cell.box.h, candidate.bottom) - Math.max(cell.box.y, candidate.top);
      return overlap >= 0.5 * Math.min(cell.box.h, candidate.bottom - candidate.top);
    });
    if (row) {
      row.cells.push(cell);
      row.top = Math.min(row.top, cell.box.y);
      row.bottom = Math.max(row.bottom, cell.box.y + cell.box.h);
    } else {
      rows.push({ cells: [cell], top: cell.box.y, bottom: cell.box.y + cell.box.h });
    }
  }
  return rows.sort((a, b) => a.top - b.top).map((row) => row.cells.sort((a, b) => a.box.x - b.box.x));
}

const rowTop = (row: TextLine[]) => Math.min(...row.map((cell) => cell.box.y));
const rowBottom = (row: TextLine[]) => Math.max(...row.map((cell) => cell.box.y + cell.box.h));

// ---------------------------------------------------------------------------
// Helpers

/** OCR reads a drawn arrow beside a label as text ("←Oxygen", "—Water"). */
const stripArrows = (label: string) => label.replace(/^[\s←→↔↑↓⟵⟶—–\-=<>]+|[\s←→↔↑↓⟵⟶—–\-=<>]+$/g, "");

/** Every word of the label appears in the description ("Carbon" in "…labelled Carbon dioxide…"). */
function namedIn(label: string, description: string): boolean {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const described = new Set(words(description));
  const labelWords = words(label);
  return labelWords.length > 0 && labelWords.every((word) => described.has(word));
}

function maxBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

const center = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const containsPoint = (box: Box, point: { x: number; y: number }) =>
  point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
const horizontalOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
const verticalOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

function mostlyInside(box: Box, region: Box) {
  return area(box) > 0 && overlapArea(box, region) >= 0.5 * area(box);
}

function distance(a: Box, b: Box) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.max(dx, dy);
}

function pad(box: Box, by: number): Box {
  const x = Math.max(0, box.x - by);
  const y = Math.max(0, box.y - by);
  return { x, y, w: Math.min(1, box.x + box.w + by) - x, h: Math.min(1, box.y + box.h + by) - y };
}

const area = (box: Box) => box.w * box.h;
