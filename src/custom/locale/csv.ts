/**
 * CSV files as Brazilian users actually produce them (fork, P-004,
 * docs/LOCALIZATION.md).
 *
 * Excel in pt-BR saves "CSV (separado por vírgulas)" with **semicolons**
 * (the comma is the decimal separator), in **Windows-1252** unless the
 * user picks "CSV UTF-8", often with a BOM, and people name the columns
 * in Portuguese (`telefone`, `nome`, `empresa`). The core parser
 * (`src/lib/contacts/parse-contact-csv.ts`) only understands
 * comma-separated UTF-8 with English headers, so:
 *
 *   - `decodeCsvBytes` picks UTF-8 or Windows-1252 (browser file reads);
 *   - `normalizeCsvText` strips the BOM, rewrites `;` / tab separated
 *     files as comma separated and maps Portuguese header aliases onto
 *     the core column names. A plain upstream-style CSV passes through
 *     unchanged.
 */

/** Portuguese (and common variant) header → core column name. */
const HEADER_ALIASES: Record<string, string> = {
  telefone: 'phone',
  fone: 'phone',
  celular: 'phone',
  whatsapp: 'phone',
  numero: 'phone',
  'numero de telefone': 'phone',
  'numero do whatsapp': 'phone',
  'telefone celular': 'phone',
  nome: 'name',
  'nome completo': 'name',
  'e-mail': 'email',
  'endereco de e-mail': 'email',
  empresa: 'company',
  'nome da empresa': 'company',
  etiquetas: 'tags',
  marcadores: 'tags',
  tag: 'tags',
};

function headerKey(cell: string): string {
  return cell
    .replace(/["']/g, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** Split one line on `delimiter`, honouring double quotes (kept as-is). */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function countOutsideQuotes(line: string, char: string): number {
  let n = 0;
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === char && !inQuotes) n++;
  }
  return n;
}

/** `,` unless the header row has more `;` (or tabs) than commas. */
export function detectCsvDelimiter(headerLine: string): ',' | ';' | '\t' {
  const commas = countOutsideQuotes(headerLine, ',');
  const semis = countOutsideQuotes(headerLine, ';');
  const tabs = countOutsideQuotes(headerLine, '\t');
  if (semis > commas && semis >= tabs) return ';';
  if (tabs > commas && tabs > semis) return '\t';
  return ',';
}

/** Re-quote a cell for a comma-separated line if it needs it. */
function toCommaCell(cell: string): string {
  const trimmed = cell.trim();
  if (/^"[\s\S]*"$/.test(trimmed)) return trimmed; // already quoted
  return trimmed.includes(',') ? `"${trimmed.replace(/"/g, '')}"` : trimmed;
}

export function normalizeCsvText(text: string): string {
  const withoutBom = text.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== '');
  if (headerIdx === -1) return withoutBom;

  const delimiter = detectCsvDelimiter(lines[headerIdx]);
  const header = splitLine(lines[headerIdx], delimiter).map((cell) => {
    const alias = HEADER_ALIASES[headerKey(cell)];
    return alias ?? cell;
  });

  if (delimiter === ',') {
    lines[headerIdx] = header.join(',');
    return lines.join('\n');
  }
  return lines
    .map((line, i) => {
      if (i < headerIdx || !line.trim()) return line;
      const cells = i === headerIdx ? header : splitLine(line, delimiter);
      return cells.map(toCommaCell).join(',');
    })
    .join('\n');
}

/**
 * Decode an uploaded CSV: UTF-8 when it is valid UTF-8 (incl. "CSV
 * UTF-8" from Excel), else Windows-1252 (Excel's default "CSV" in
 * pt-BR), so `São Paulo` is not read as `S�o Paulo`.
 */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Read a `File` picked in the browser with {@link decodeCsvBytes}. */
export async function readCsvFile(file: Blob): Promise<string> {
  return decodeCsvBytes(await file.arrayBuffer());
}
