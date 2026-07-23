import { IngestionError } from './errors';
import { normalizeIdentifier } from './identifiers';

export interface KaggleDatasetRef { owner: string; slug: string; version?: number; canonicalRef: string }

export function parseKaggleDatasetUrl(input: string): KaggleDatasetRef {
  const cleaned = input.trim().replace(/[),.;]+$/, '');
  let url: URL;
  try { url = new URL(cleaned); } catch { throw new IngestionError('INVALID_KAGGLE_URL', 'Invalid Kaggle dataset URL', { url: input }); }
  if (!['http:', 'https:'].includes(url.protocol) || !['kaggle.com', 'www.kaggle.com'].includes(url.hostname.toLowerCase())) throw new IngestionError('INVALID_KAGGLE_URL', 'Invalid Kaggle dataset URL', { url: input });
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'datasets') throw new IngestionError('INVALID_KAGGLE_URL', 'URL must point to /datasets/{owner}/{slug}', { url: input });
  const owner = normalizeIdentifier(parts[1]); const slug = normalizeIdentifier(parts[2]);
  if (!owner || !slug) throw new IngestionError('INVALID_KAGGLE_URL', 'Dataset owner and slug are required', { url: input });
  let version: number | undefined;
  if (parts.length > 3) {
    if (parts.length !== 5 || parts[3].toLowerCase() !== 'versions' || !/^\d+$/.test(parts[4]) || Number(parts[4]) < 1) throw new IngestionError('INVALID_KAGGLE_URL', 'Invalid dataset version', { url: input });
    version = Number(parts[4]);
  }
  return { owner, slug, ...(version === undefined ? {} : { version }), canonicalRef: `${owner}/${slug}${version === undefined ? '' : `/versions/${version}`}` };
}
