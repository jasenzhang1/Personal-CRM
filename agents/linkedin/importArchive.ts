/**
 * Import a LinkedIn data archive (.zip) into the CRM database with the same code the Import page
 * uses: Connections.csv → ingest (new people go to the Inbox) → sure-thing name fixes.
 */
import { unzipSync } from 'fflate';
import type { SQLiteDatabase } from '../../src/db/types.ts';
import { applyNameSuggestions, AUTO_NAMES_KEY } from '../../src/db/names.ts';
import { getSetting } from '../../src/db/people.ts';
import { ingest, type IngestResult } from '../../src/sync/ingest.ts';
import { parseMany } from '../../src/sync/parsers.ts';
import type { Edit } from '../lib/dataRepo.ts';

/** LinkedIn's archives (the quick first part and the complete one) both carry Connections.csv. */
export function connectionsFrom(zip: Uint8Array, zipName = 'linkedin.zip'): { name: string; text: string }[] {
  const files = unzipSync(zip, { filter: (e) => e.name.split('/').pop()!.toLowerCase() === 'connections.csv' });
  return Object.entries(files).map(([name, bytes]) => ({ name: `${zipName} › ${name}`, text: new TextDecoder().decode(bytes) }));
}

export function describe(r: IngestResult): string {
  const where = r.added ? (r.baseline ? ' → Older connections' : ' → Inbox') : '';
  return `LinkedIn: ${r.total} connections · ${r.added} new${where} · ${r.linked} matched` + (r.maybeRenamed ? ` · ${r.maybeRenamed} may have changed their profile link (see Duplicates)` : '');
}

/** Import one archive. `changed` is false when it held nobody new, so nothing gets committed. */
export async function importLinkedInZip(db: SQLiteDatabase, zip: Uint8Array, zipName?: string): Promise<Edit & { result: IngestResult }> {
  const entries = connectionsFrom(zip, zipName);
  if (!entries.length) throw new Error(`${zipName ?? 'The archive'} has no Connections.csv. LinkedIn sometimes leaves it out of the quick first part; the complete archive has it.`);
  const batch = parseMany(entries);
  const failed = batch.files.find((f) => f.error);
  const candidates = batch.bySource.get('linkedin');
  if (!candidates?.length) throw new Error(failed?.error ?? 'No connections found in Connections.csv.');
  const result = await ingest(db, 'linkedin', candidates);
  let fixed = 0;
  if (result.added && (await getSetting(db, AUTO_NAMES_KEY)) !== '0') fixed = (await applyNameSuggestions(db)).fixed;
  const summary = describe(result) + (fixed ? ` · cleaned up ${fixed} names` : '');
  // Imports only fill blanks, so an archive with nobody new or newly matched isn't worth a commit.
  return { changed: result.added + result.linked + result.relabeled + result.maybeRenamed > 0, summary, result };
}
