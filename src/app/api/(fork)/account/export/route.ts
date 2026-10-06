/**
 * GET /api/account/export — the organization's contacts as CSV (fork,
 * docs/DELINQUENCY.md). Data export is never blocked by the delinquency
 * policy (suspended / cancelled organizations keep it). Admins; read
 * through the caller's RLS-scoped client, so only their own organization.
 */
import { requireRole, toErrorResponse } from '@/custom/core/server';
import { toCsv } from '@/custom/export/csv';

const PAGE = 1000;
const HEADER = [
  'nome',
  'telefone',
  'email',
  'empresa',
  'tipo_pessoa',
  'cpf_cnpj',
  'razao_social',
  'cep',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'criado_em',
];

interface Row {
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  created_at: string;
  br_contact_profiles:
    Record<string, string | null> | Record<string, string | null>[] | null;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const rows: string[][] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('contacts')
        .select(
          'name, phone, email, company, created_at, br_contact_profiles(person_type, tax_id, legal_name, postal_code, street, street_number, complement, district, city, state)'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const c of (data ?? []) as Row[]) {
        const br =
          (Array.isArray(c.br_contact_profiles)
            ? c.br_contact_profiles[0]
            : c.br_contact_profiles) ?? {};
        rows.push(
          [
            c.name,
            c.phone,
            c.email,
            c.company,
            br.person_type,
            br.tax_id,
            br.legal_name,
            br.postal_code,
            br.street,
            br.street_number,
            br.complement,
            br.district,
            br.city,
            br.state,
            c.created_at,
          ].map((v) => v ?? '')
        );
      }
      if (!data || data.length < PAGE) break;
    }
    const date = new Date().toISOString().slice(0, 10);
    return new Response(toCsv(HEADER, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="contatos-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
