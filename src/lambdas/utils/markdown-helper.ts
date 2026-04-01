/**
 * Pulizia leggera del Markdown restituito dagli agenti Bedrock.
 *
 * Regole:
 * 1. Rimuove i backtick wrapper (```markdown ... ```) se presenti.
 * 2. Rimuove tag XML residui (es. <AREA>, <SUMMARY>).
 * 3. NON taglia il testo prima del primo '#': questo causava la perdita
 *    di intestazioni di chunk intermedi e malformava il Markdown finale.
 *
 * Nota: questa funzione va applicata SOLO al finalReport del Domain Lead,
 * non ai report intermedi dei sotto-agenti (che vengono concatenati grezzi).
 */
export function sanitizeMarkdown(text: string): string {
  if (!text) return '';
  let cleaned = text.trim();

  // Rimuove wrapper ```markdown ... ``` o ``` ... ```
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(markdown)?\n?/, '').replace(/\n?```$/, '');
  }

  // Rimuove tag XML residui
  cleaned = cleaned.replace(/<[^>]*>?/gm, '');

  return cleaned.trim();
}

/**
 * Versione raw: nessuna pulizia — usata per i report intermedi
 * dei sotto-agenti che vengono concatenati prima di passare al Domain Lead.
 */
export function rawAgentOutput(text: string): string {
  return text?.trim() ?? '';
}