const dictionary = new Map([
  [".NET", ".NET"],
  ["AGI", "AGI"],
  ["AI", "AI"],
  ["API", "API"],
  ["CLI", "CLI"],
  ["CSHARP", "CSharp"],
  ["CSS", "CSS"],
  ["CSV", "CSV"],
  ["HTML", "HTML"],
  ["HTTP", "HTTP"],
  ["HTTPS", "HTTPS"],
  ["ID", "ID"],
  ["IP", "IP"],
  ["JAVASCRIPT", "JavaScript"],
  ["JS", "JS"],
  ["JSON", "JSON"],
  ["JSONL", "JSONL"],
  ["JWE", "JWE"],
  ["JWK", "JWK"],
  ["JWS", "JWS"],
  ["JWT", "JWT"],
  ["LLM", "LLM"],
  ["MARKDOWN", "Markdown"],
  ["MCP", "MCP"],
  ["ML", "ML"],
  ["OPENAI", "OpenAI"],
  ["OPENAPI", "OpenAPI"],
  ["PKI", "PKI"],
  ["RFC", "RFC"],
  ["SDK", "SDK"],
  ["SQL", "SQL"],
  ["SSE", "SSE"],
  ["SSL", "SSL"],
  ["TCP", "TCP"],
  ["TLS", "TLS"],
  ["TYPESCRIPT", "TypeScript"],
  ["UDP", "UDP"],
  ["URL", "URL"],
  ["UUID", "UUID"],
  ["XML", "XML"],
  ["YAML", "YAML"],
]);

/**
 * Applies canonical casing to known proper nouns and acronyms.
 *
 * The input string is first checked as a whole against the dictionary. If no
 * match is found, it is split on spaces and hyphens and each word is resolved
 * independently, preserving the original delimiters. All-uppercase words not
 * in the dictionary are kept as-is (assumed intentional). Words that are
 * neither recognized nor all-uppercase pass through unchanged.
 *
 * Returns the input string with any recognized words replaced by their
 * canonical forms.
 */
export function properCase(str: string): string {
  // Try the whole string first as a single lookup
  const upper = str.toUpperCase();
  const found = dictionary.get(upper);
  if (found) {
    return found;
  }

  // Split on spaces/hyphens, try each word, recompose with original delimiters
  const parts = str.split(/([ -])/);
  if (parts.length <= 1) {
    return str;
  }

  let anyResolved = false;
  const result = parts.map((part, i) => {
    // Odd indices are the delimiters themselves
    if (i % 2 === 1) return part;

    const wordUpper = part.toUpperCase();
    const wordFound = dictionary.get(wordUpper);
    if (wordFound) {
      anyResolved = true;
      return wordFound;
    }
    // Preserve all-uppercase words as-is (intentional acronyms/abbreviations)
    if (part === wordUpper) {
      anyResolved = true;
      return part;
    }
    return part;
  });

  return anyResolved ? result.join("") : str;
}
