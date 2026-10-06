import { describe, expect, it } from 'vitest';

import { csvCell, toCsv } from './csv';

describe('CSV export', () => {
  it('BOM, ; separator, CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', 'São Paulo']])).toBe(
      '\uFEFFa;b\r\n1;São Paulo\r\n'
    );
  });
  it('quotes separators/quotes and neutralizes formulas', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+55 (11) 99999-0000')).toBe('+55 (11) 99999-0000');
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('linha\nnova')).toBe('linha nova');
  });
});
