import { sanitizeMarkdown, rawAgentOutput } from './markdown-helper';

describe('MarkdownHelper', () => {
    describe('sanitizeMarkdown', () => {
        it('dovrebbe rimuovere i wrapper di blocco codice markdown', () => {
            const input = '```markdown\n# Titolo\nTesto\n```';
            expect(sanitizeMarkdown(input)).toBe('# Titolo\nTesto');
        });

        it('dovrebbe rimuovere i wrapper di blocco codice generici', () => {
            const input = '```\nContenuto\n```';
            expect(sanitizeMarkdown(input)).toBe('Contenuto');
        });

        it('dovrebbe rimuovere tag XML residui', () => {
            const input = '<AREA>Analisi</AREA>\n<REPORT>Dettagli</REPORT>';
            // Il regex /<[^>]*>?/gm rimuove tutto ciò che è tra < e >
            expect(sanitizeMarkdown(input)).toBe('Analisi\nDettagli');
        });

        it('dovrebbe gestire stringhe vuote o nulle', () => {
            expect(sanitizeMarkdown('')).toBe('');
            expect(sanitizeMarkdown(null as any)).toBe('');
        });

        it('dovrebbe restituire il testo pulito dagli spazi', () => {
            expect(sanitizeMarkdown('  Testo sporco  ')).toBe('Testo sporco');
        });
    });

    describe('rawAgentOutput', () => {
        it('dovrebbe fare solo il trim del testo', () => {
            expect(rawAgentOutput('  Contenuto Grezzo  ')).toBe('Contenuto Grezzo');
        });

        it('dovrebbe gestire casi null/undefined', () => {
            expect(rawAgentOutput(null as any)).toBe('');
            expect(rawAgentOutput(undefined as any)).toBe('');
        });
    });
});
