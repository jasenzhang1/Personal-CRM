import { unzipSync } from 'fflate';
import { isMessageEntry } from './messages';
import { isRelevantExportEntry } from './parsers';

/**
 * Turn whatever the user dropped (loose files and/or whole export .zips) into text files
 * the parsers understand. Zips are opened in the browser; only relevant entries are decompressed.
 */
export async function expandFiles(files: File[]): Promise<{ entries: { name: string; text: string }[]; notes: string[] }> {
  const entries: { name: string; text: string }[] = [];
  const notes: string[] = [];
  const decoder = new TextDecoder();
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      let unzipped: Record<string, Uint8Array>;
      try {
        unzipped = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => isRelevantExportEntry(e.name) || isMessageEntry(e.name) });
      } catch {
        notes.push(`${f.name}: couldn't open this zip.`);
        continue;
      }
      const names = Object.keys(unzipped);
      if (!names.length) notes.push(`${f.name}: no contacts or messages found inside. Make sure the export includes followers/friends/connections or messages, in JSON format.`);
      for (const name of names) entries.push({ name: `${f.name} › ${name}`, text: decoder.decode(unzipped[name]) });
    } else {
      entries.push({ name: f.name, text: await f.text() });
    }
  }
  return { entries, notes };
}
