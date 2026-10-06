/**
 * CSV for spreadsheet users in Brazil (fork): `;` separator and a UTF-8
 * BOM so Excel pt-BR opens accents and columns correctly. Cells that
 * could run as a formula (= @, or + - followed by something other than a
 * number, e.g. +HYPERLINK) get a leading ' (CSV injection); phone numbers
 * like +5511… stay intact.
 */
export function csvCell(value: string): string {
  let v = value.replace(/\r?\n/g, ' ');
  if (/^[=@\t\r]/.test(v) || /^[+-](?![\d\s().-]*$)/.test(v)) v = `'${v}`;
  return /[";]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
