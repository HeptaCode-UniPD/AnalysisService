import { readFileSync, unlinkSync, existsSync } from 'fs';

const MAX_BUNDLE_CHARS = 150_000;

async function runRepomix(
  extractPath: string,
  include: string,
  ignore: string,
  outputSuffix: string,
): Promise<string> {
  const outputPath = `/tmp/repomix-${outputSuffix}-${Date.now()}.txt`;

  try {
    const { runCli } = await import('repomix');

    await runCli([extractPath], extractPath, {
      include,
      ignore,
      style: 'plain',
      output: outputPath,
      quiet: true,
      securityCheck: false,
    } as any);

    if (!existsSync(outputPath)) {
      console.warn(`[SmartBundler] Output file not found for ${outputSuffix}`);
      return '';
    }

    const content = readFileSync(outputPath, 'utf-8');
    try { unlinkSync(outputPath); } catch { /* ignore */ }

    return content;
  } catch (err: any) {
    console.error(`[SmartBundler] Errore creazione bundle ${outputSuffix}:`, err?.message);
    return '';
  }
}

/**
 * Spezza una stringa in chunk da MAX_BUNDLE_CHARS caratteri.
 * Tenta di tagliare al separatore di file repomix ("================")
 * per non spezzare un blocco file a metà.
 */
function splitIntoChunks(content: string, chunkSize: number = MAX_BUNDLE_CHARS): string[] {
  if (content.length <= chunkSize) return [content];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    let end = offset + chunkSize;

    if (end < content.length) {
      // Cerca il separatore repomix più vicino prima del limite,
      // ma solo se si trova nell'ultima metà del chunk (evita chunk troppo piccoli)
      const boundary = content.lastIndexOf('\n================', end);
      if (boundary > offset + chunkSize * 0.5) {
        end = boundary;
      }
    }

    chunks.push(content.substring(offset, end));
    offset = end;
  }

  console.log(`[SmartBundler] Bundle spezzato in ${chunks.length} chunk (chunkSize: ${chunkSize} chars)`);
  return chunks;
}

// ─── Bundle singoli (primo chunk, per bundle piccoli o per retro-compatibilità) ───

export async function createSourceBundle(extractPath: string): Promise<string> {
  const raw = await runRepomix(
    extractPath,
    '**/*.{ts,js,mjs,cjs,jsx,tsx,php,py,java,go,rb,c,cpp,cs,rs,swift,kt}',
    '**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/target/**',
    'source',
  );
  if (raw.length > MAX_BUNDLE_CHARS) {
    console.warn(`[SmartBundler] source bundle grande (${raw.length} chars) — usa createSourceChunks per analisi completa`);
  }
  return raw.substring(0, MAX_BUNDLE_CHARS);
}

export async function createManifestBundle(extractPath: string): Promise<string> {
  const raw = await runRepomix(
    extractPath,
    '**/package.json,**/package-lock.json,**/composer.json,**/composer.lock,**/requirements.txt,**/requirements*.txt,**/Pipfile,**/Pipfile.lock,**/pom.xml,**/build.gradle,**/build.gradle.kts,**/go.mod,**/go.sum,**/Gemfile,**/Gemfile.lock,**/Cargo.toml,**/Cargo.lock',
    '**/node_modules/**,**/vendor/**',
    'manifest',
  );
  return raw.substring(0, MAX_BUNDLE_CHARS);
}

export async function createFullBundle(extractPath: string): Promise<string> {
  const raw = await runRepomix(
    extractPath,
    '**/*',
    '**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/target/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.ico,**/*.svg,**/*.woff,**/*.woff2,**/*.ttf,**/*.eot,**/*.otf,**/*.mp4,**/*.mp3,**/*.zip,**/*.tar,**/*.gz,**/*.pdf,**/*.bin',
    'full',
  );
  return raw.substring(0, MAX_BUNDLE_CHARS);
}

export async function createConfigBundle(extractPath: string): Promise<string> {
  const raw = await runRepomix(
    extractPath,
    '**/.env*,**/nginx.conf,**/nginx*.conf,**/.htaccess,**/php.ini,**/web.config,**/docker-compose*.yml,**/docker-compose*.yaml,**/*.dockerfile,**/Dockerfile*,**/httpd.conf,**/apache*.conf,**/*.ini,**/*.cfg,**/settings.py,**/config.py,**/application.yml,**/application.properties,**/cors.*',
    '**/node_modules/**,**/vendor/**,**/dist/**,**/.git/**',
    'config',
  );
  return raw.substring(0, MAX_BUNDLE_CHARS);
}

// ─── Bundle chunked (array di chunk ≤ MAX_BUNDLE_CHARS, copertura completa) ───

/**
 * Ritorna tutti i file sorgente spezzati in chunk sequenziali.
 * Usare per OWASP Top10 e Config Audit dove serve vedere tutto il codice.
 */
export async function createSourceChunks(extractPath: string): Promise<string[]> {
  const raw = await runRepomix(
    extractPath,
    '**/*.{ts,js,mjs,cjs,jsx,tsx,php,py,java,go,rb,c,cpp,cs,rs,swift,kt}',
    '**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/target/**',
    'source-chunked',
  );
  return splitIntoChunks(raw);
}

/**
 * Ritorna il bundle completo spezzato in chunk sequenziali.
 * Usare per Credential Scanner dove serve vedere ogni file testuale.
 */
export async function createFullChunks(extractPath: string): Promise<string[]> {
  const raw = await runRepomix(
    extractPath,
    '**/*',
    '**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/target/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.ico,**/*.svg,**/*.woff,**/*.woff2,**/*.ttf,**/*.eot,**/*.otf,**/*.mp4,**/*.mp3,**/*.zip,**/*.tar,**/*.gz,**/*.pdf,**/*.bin',
    'full-chunked',
  );
  return splitIntoChunks(raw);
}

// ─── Utility: estrazione statica librerie importate (senza LLM) ───

export function extractImportedLibraries(sourceChunks: string | string[]): string[] {
  const libs = new Set<string>();
  const content = Array.isArray(sourceChunks) ? sourceChunks.join('\n') : sourceChunks;

  const jsPatterns = [
    /(?:^|\s)(?:import|require)\s*(?:\(?\s*['"`])((?!\.{1,2}[/\\])[^'"``.]+)(?:['"`])/gm,
    /from\s+['"`]((?!\.{1,2}[/\\])[^'"``.]+)['"`]/gm,
  ];
  const phpPatterns = [
    /^use\s+([\w\\]+)/gm,
    /(?:require|include)(?:_once)?\s*[\(]?\s*['"`]([^'"``.]+)['"`]/gm,
  ];
  const pyPatterns = [
    /^import\s+([\w.]+)/gm,
    /^from\s+([\w.]+)\s+import/gm,
  ];
  const javaPatterns = [/^import\s+([\w.]+);/gm];

  for (const pattern of [...jsPatterns, ...phpPatterns, ...pyPatterns, ...javaPatterns]) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lib = match[1].split('/')[0].split('\\')[0];
      if (lib && lib.length > 1 && !lib.startsWith('.')) {
        libs.add(lib);
      }
    }
  }

  return Array.from(libs).sort();
}